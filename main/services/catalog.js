'use strict';

const fs = require('fs');
const path = require('path');
const { fetchSource, compareVersion } = require('./repos');
const logger = require('./logger');

const CACHE_TTL = 30 * 60 * 1000;

let cacheFile = null;
let state = { entries: [], errors: [], ts: 0, sources: [] };
let inflight = null;
let getSettings = () => ({ sources: [], credentials: { github: '', gitee: '' } });

function init(userDataDir, settingsGetter) {
  cacheFile = path.join(userDataDir, 'cache', 'catalog.json');
  if (settingsGetter) getSettings = settingsGetter;
  loadFromDisk();
}

function loadFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (Array.isArray(raw.entries)) {
      state = {
        entries: raw.entries.map(decorate),
        errors: raw.errors || [],
        ts: raw.ts || 0,
        sources: raw.sources || [],
      };
      logger.info('catalog', `读取本地缓存，${state.entries.length} 项`);
    }
  } catch {
    /* 首次启动无缓存 */
  }
}

function saveToDisk() {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(state), 'utf8');
  } catch (e) {
    logger.warn('catalog', '缓存写入失败：' + e.message);
  }
}

function decorate(entry) {
  return { ...entry, _idx: buildIndex(entry) };
}

function buildIndex(entry) {
  return [entry.name, entry.author, entry.description, (entry.tags || []).join(' '), entry.id]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function merge(entries) {
  const map = new Map();
  for (const e of entries) {
    const key = String(e.id);
    const exist = map.get(key);
    if (!exist) {
      map.set(key, { ...e, sources: [e.sourceLabel] });
      continue;
    }
    // 同 id：保留更高版本，来源合并以便用户知道多源可选
    const sources = new Set([...(exist.sources || []), e.sourceLabel]);
    const winner = compareVersion(e.version, exist.version) > 0 ? { ...e, sources: [...sources] } : { ...exist, sources: [...sources] };
    map.set(key, winner);
  }
  return [...map.values()].map(decorate);
}

async function refresh({ force = false } = {}) {
  const settings = getSettings();
  const sources = (settings.sources || []).filter((s) => s.enabled);

  if (!force && state.entries.length && Date.now() - state.ts < CACHE_TTL) {
    return snapshot(true);
  }
  if (inflight) return inflight;

  if (!sources.length) {
    state = { entries: [], errors: [], ts: Date.now(), sources: [] };
    saveToDisk();
    return snapshot(false);
  }

  inflight = (async () => {
    const started = Date.now();
    const results = await Promise.all(
      sources.map((src) => fetchSource(src, settings.credentials || settings.token || ''))
    );
    const all = [];
    const errors = [];
    for (const r of results) {
      if (r.error) errors.push({ sourceId: r.src.id, label: `${r.src.owner}/${r.src.repo}`, message: r.error });
      all.push(...r.entries);
    }
    state = {
      entries: merge(all),
      errors,
      ts: Date.now(),
      sources: sources.map((s) => ({ id: s.id, label: `${s.owner}/${s.repo}`, platform: s.platform })),
    };
    saveToDisk();
    logger.info(
      'catalog',
      `聚合完成：${state.entries.length} 项 / ${sources.length} 个源 / ${Date.now() - started}ms${
        errors.length ? ` / ${errors.length} 个源失败` : ''
      }`
    );
    return snapshot(false);
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

function snapshot(fromCache) {
  return {
    entries: state.entries.map(({ _idx, ...rest }) => rest),
    errors: state.errors,
    ts: state.ts,
    fromCache: !!fromCache,
    sources: state.sources,
  };
}

function all() {
  return state.entries;
}

function get(id) {
  return state.entries.find((e) => String(e.id) === String(id)) || null;
}

function search({ q = '', type = 'all', sort = 'updated' } = {}) {
  const query = String(q || '').trim().toLowerCase();
  let list = state.entries;

  if (type && type !== 'all') {
    list = list.filter((e) => e.type === type);
  }
  if (query) {
    const words = query.split(/\s+/).filter(Boolean);
    list = list.filter((e) => words.every((w) => e._idx.includes(w)));
  }

  const sorted = list.slice();
  switch (sort) {
    case 'name':
      sorted.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
      break;
    case 'size':
      sorted.sort((a, b) => (b.size || 0) - (a.size || 0));
      break;
    case 'version':
      sorted.sort((a, b) => compareVersion(b.version, a.version));
      break;
    case 'updated':
    default:
      sorted.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
      break;
  }
  return sorted.map(({ _idx, ...rest }) => rest);
}

/** 依赖检查：返回缺失依赖与将被带入的依赖 */
function resolveDeps(id, installedIds = []) {
  const map = new Map(state.entries.map((e) => [String(e.id), e]));
  const target = map.get(String(id));
  if (!target) return { required: [], missing: [], cycle: false };

  const required = [];
  const missing = [];
  const seen = new Set();
  let cycle = false;

  const walk = (entry, depth) => {
    if (depth > 6) return;
    for (const depId of entry.deps || []) {
      if (seen.has(depId)) {
        cycle = true;
        continue;
      }
      seen.add(depId);
      const dep = map.get(String(depId));
      if (!dep) {
        missing.push({ id: depId, name: depId, reason: '源中未收录该依赖' });
        continue;
      }
      if (!installedIds.includes(String(depId))) {
        required.push({ id: dep.id, name: dep.name, version: dep.version, size: dep.size });
        walk(dep, depth + 1);
      }
    }
  };

  walk(target, 0);
  return { required, missing, cycle };
}

function stats() {
  const byType = {};
  for (const e of state.entries) byType[e.type] = (byType[e.type] || 0) + 1;
  return {
    total: state.entries.length,
    byType,
    ts: state.ts,
    errors: state.errors,
    sources: state.sources,
  };
}

function clearCache() {
  state = { entries: [], errors: [], ts: 0, sources: [] };
  try {
    fs.unlinkSync(cacheFile);
  } catch {
    /* 缓存文件可能不存在 */
  }
  return true;
}

module.exports = { init, refresh, search, get, all, resolveDeps, stats, clearCache, snapshot };
