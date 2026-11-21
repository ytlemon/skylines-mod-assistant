'use strict';

const { getText, getJson } = require('./http');
const semver = require('semver');
const logger = require('./logger');

const MANIFEST_FILES = ['mods.json', 'index.json'];
const INSTALL_TARGETS = { Mods: 'Mods', Assets: 'Assets', Maps: 'Maps' };
const TYPES = { mod: 'mod', asset: 'asset', map: 'map', tool: 'tool' };

function guessType(installTo) {
  if (installTo === 'Assets') return 'asset';
  if (installTo === 'Maps') return 'map';
  return 'mod';
}

function safeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const t = url.trim();
  if (!/^https?:\/\//i.test(t)) return '';
  return t;
}

function slug(text, fallback = 'mod') {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

/** 去掉文件名里的版本号，用于跨 release 归并同一个 Mod */
function baseAssetName(name) {
  return String(name || '')
    .replace(/\.zip$/i, '')
    .replace(/[-_. ]?v?\d+(\.\d+){1,3}([-_.]?(alpha|beta|rc|pre)\d*)?/gi, '')
    .replace(/[-_. ]+$/g, '')
    .trim();
}

function normalizeManifestEntry(raw, src, baseUrl) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || raw.title || '').trim();
  if (!name) return null;

  const installTo = INSTALL_TARGETS[raw.installTo] ? INSTALL_TARGETS[raw.installTo] : 'Mods';
  const id = String(raw.id || `${src.platform}:${src.owner}/${src.repo}#${slug(name)}`).trim();

  // 支持三种写法：绝对 http(s) 链接、仓库 raw 相对路径、以 / 开头的根相对路径
  const rawUrl = String(raw.downloadUrl || raw.url || raw.download || '').trim();
  let downloadUrl = '';
  if (/^https?:\/\//i.test(rawUrl)) {
    downloadUrl = rawUrl;
  } else if (rawUrl && baseUrl) {
    try {
      downloadUrl = new URL(rawUrl.replace(/^\/+/, ''), baseUrl).toString();
    } catch {
      downloadUrl = '';
    }
  }

  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
    : [];

  return {
    id,
    name,
    version: String(raw.version || '0.0.0').trim(),
    type: TYPES[raw.type] ? TYPES[raw.type] : guessType(installTo),
    author: String(raw.author || src.owner).trim(),
    tags,
    description: String(raw.description || raw.desc || '').trim(),
    installTo,
    dirName: String(raw.dirName || '').trim(),
    downloadUrl,
    sha256: String(raw.sha256 || '').toLowerCase(),
    size: Number(raw.size) > 0 ? Number(raw.size) : 0,
    deps: Array.isArray(raw.deps) ? raw.deps.map(String) : [],
    homepage: safeUrl(raw.homepage),
    changelog: String(raw.changelog || '').trim(),
    updated: raw.updated || '',
    sourceId: src.id,
    sourceLabel: `${src.platform === 'gitee' ? 'Gitee' : 'GitHub'} · ${src.owner}/${src.repo}`,
    platform: src.platform,
    origin: 'manifest',
  };
}

/** auth 可以是 { github, gitee } 对象，也兼容旧的单个字符串 */
function pickToken(auth, platform) {
  if (!auth) return '';
  if (typeof auth === 'string') return auth;
  return String(auth[platform] || '');
}

function authHeaders(src, auth) {
  const h = {};
  const token = pickToken(auth, src.platform);
  if (src.platform === 'github' && token) h.Authorization = `Bearer ${token}`;
  if (src.platform === 'gitee' && token) h.Authorization = `token ${token}`;
  return h;
}

/** Gitee 的 raw 地址对部分网络环境会返回 403，改用 API v5 contents（base64）兜底 */
async function fetchGiteeContents(src, file, headers) {
  const url = `https://gitee.com/api/v5/repos/${src.owner}/${src.repo}/contents/${encodeURIComponent(
    file
  )}?ref=${encodeURIComponent(src.branch)}`;
  const data = await getJson(url, { headers, timeout: 20000 });
  if (!data || !data.content) throw new Error('文件不存在');
  const text = Buffer.from(String(data.content).replace(/\s/g, ''), 'base64').toString('utf8');
  return text;
}

async function fetchManifest(src, auth) {
  const headers = authHeaders(src, auth);
  let lastErr = null;
  const branch = String(src.branch || 'main').replace(/^\/+|\/+$/g, '');

  for (const file of MANIFEST_FILES) {
    const rawBase =
      src.platform === 'gitee'
        ? `https://gitee.com/${src.owner}/${src.repo}/raw/${branch}/`
        : `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${branch}/`;
    const url = rawBase + file;

    const attempts = [() => getText(url, { headers, timeout: 20000 })];
    if (src.platform === 'gitee') {
      attempts.push(() => fetchGiteeContents(src, file, headers));
    }

    for (const attempt of attempts) {
      try {
        const text = await attempt();
        const data = JSON.parse(text);
        const list = Array.isArray(data) ? data : Array.isArray(data.mods) ? data.mods : [];
        const entries = list
          .map((item) => normalizeManifestEntry(item, src, rawBase))
          .filter((e) => e && e.downloadUrl);
        if (!entries.length) throw new Error('清单中没有可下载的条目');
        return { entries, repoName: data.name || '', file };
      } catch (e) {
        lastErr = e;
        // 清单存在但字段不合法时不再尝试别的通道
        if (/清单中没有可下载的条目/.test(e.message)) throw e;
      }
    }
  }
  throw new Error(
    `读取清单失败（${branch}/mods.json 或 index.json）：${lastErr ? lastErr.message : '未知错误'}`
  );
}

async function fetchReleases(src, auth) {
  const headers = authHeaders(src, auth);
  const url =
    src.platform === 'gitee'
      ? `https://gitee.com/api/v5/repos/${src.owner}/${src.repo}/releases?per_page=30&direction=desc`
      : `https://api.github.com/repos/${src.owner}/${src.repo}/releases?per_page=30`;

  const releases = await getJson(url, { headers, timeout: 25000 });
  if (!Array.isArray(releases)) throw new Error('Releases 返回格式异常');

  const entries = [];
  for (const rel of releases) {
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const zips = assets.filter((a) => /\.zip$/i.test(a.name || ''));
    for (const asset of zips) {
      const modName = String(rel.name || rel.tag_name || asset.name).trim();
      const base = baseAssetName(asset.name) || slug(modName);
      entries.push({
        id: `rel:${src.owner}/${src.repo}/${slug(base)}`,
        name: modName,
        version: String(rel.tag_name || rel.name || '0.0.0').replace(/^v/i, ''),
        type: 'mod',
        author: src.owner,
        tags: [],
        description: String(rel.body || '').slice(0, 500).trim(),
        installTo: 'Mods',
        dirName: '',
        downloadUrl: safeUrl(asset.browser_download_url),
        sha256: '',
        size: Number(asset.size) > 0 ? Number(asset.size) : 0,
        deps: [],
        homepage: `https://${src.platform === 'gitee' ? 'gitee.com' : 'github.com'}/${src.owner}/${src.repo}`,
        changelog: String(rel.body || '').slice(0, 2000).trim(),
        updated: rel.published_at || '',
        sourceId: src.id,
        sourceLabel: `${src.platform === 'gitee' ? 'Gitee' : 'GitHub'} · ${src.owner}/${src.repo}`,
        platform: src.platform,
        origin: 'release',
      });
    }
  }
  if (!entries.length) throw new Error('该仓库的 Releases 中没有 .zip 安装包');
  return { entries, repoName: src.repo };
}

/** 抓取单个源 */
async function fetchSource(src, auth) {
  if (!src.enabled) return { src, entries: [], error: null, skipped: true };
  try {
    const result =
      src.mode === 'releases' ? await fetchReleases(src, auth) : await fetchManifest(src, auth);
    logger.info('repos', `源加载成功 ${src.id}（${result.entries.length} 项）`);
    return { src, entries: result.entries, error: null };
  } catch (e) {
    logger.warn('repos', `源加载失败 ${src.id}：${e.message}`);
    return { src, entries: [], error: humanizeError(e, src) };
  }
}

function humanizeError(e, src) {
  const code = e.statusCode;
  if (code === 404) {
    return src.mode === 'releases'
      ? '仓库不存在，或没有公开的 Releases'
      : '仓库不存在，或清单文件不存在（需在根目录放 mods.json）';
  }
  if (code === 403 || code === 429) return '接口限流，请在设置中填写 Token 后重试';
  if (code === 401) return 'Token 无效或已过期';
  return e.message || '未知错误';
}

/** 版本比较：优先 semver，退化到字符串比较 */
function compareVersion(a, b) {
  const va = String(a || '').trim();
  const vb = String(b || '').trim();
  const ca = semver.coerce(va);
  const cb = semver.coerce(vb);
  if (ca && cb) return semver.compare(ca, cb);
  if (va === vb) return 0;
  return va > vb ? 1 : -1;
}

module.exports = {
  fetchSource,
  compareVersion,
  normalizeManifestEntry,
  baseAssetName,
  slug,
  MANIFEST_FILES,
};
