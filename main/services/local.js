'use strict';

const fs = require('fs');
const path = require('path');
const { dirSize, findDll, META_FILE, sanitizeDirName } = require('./installer');
const { compareVersion } = require('./repos');

const TARGETS = ['Mods', 'Assets', 'Maps'];
let userDataDir = null;
let getPaths = () => ({ valid: false });

function init({ userDataDir: dir, getPaths: gp }) {
  userDataDir = dir;
  getPaths = gp;
}

function readMeta(dir) {
  const file = path.join(dir, META_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function describeDir(dir, { installTo, enabled, stashRoot }) {
  const meta = readMeta(dir);
  const dll = findDll(dir);
  const stat = (() => {
    try {
      return fs.statSync(dir);
    } catch {
      return null;
    }
  })();

  return {
    id: meta && meta.id ? meta.id : `local:${installTo}/${path.basename(dir)}`,
    name: (meta && meta.name) || path.basename(dir),
    version: (meta && meta.version) || '',
    author: (meta && meta.author) || '',
    type: (meta && meta.type) || (installTo === 'Assets' ? 'asset' : installTo === 'Maps' ? 'map' : 'mod'),
    installTo: (meta && meta.installTo) || installTo,
    dirName: path.basename(dir),
    path: dir,
    stashRoot: stashRoot || '',
    size: dirSize(dir),
    hasDll: !!dll,
    manual: !meta,
    enabled,
    installedAt: (meta && meta.installedAt) || (stat ? stat.mtime.toISOString() : ''),
    tags: (meta && meta.tags) || [],
    deps: (meta && meta.deps) || [],
    description: (meta && meta.description) || '',
    homepage: (meta && meta.homepage) || '',
    sourceLabel: (meta && meta.sourceLabel) || '',
    platform: (meta && meta.platform) || '',
    origin: (meta && meta.origin) || 'manual',
  };
}

function scanEnabled(paths) {
  const items = [];
  for (const target of TARGETS) {
    const base =
      target === 'Assets' ? paths.assets : target === 'Maps' ? paths.maps : paths.mods;
    if (!base || !fs.existsSync(base)) continue;
    let children = [];
    try {
      children = fs.readdirSync(base, { withFileTypes: true }).filter((c) => c.isDirectory());
    } catch {
      continue;
    }
    for (const child of children) {
      if (child.name.startsWith('.') || child.name === '__MACOSX') continue;
      // 兼容「Mods 下再套一层」的手动安装习惯：只在确无文件时下钻一层
      const full = path.join(base, child.name);
      items.push(describeDir(full, { installTo: target, enabled: true }));
    }
  }
  return items;
}

function scanDisabled() {
  const root = path.join(userDataDir, 'disabled');
  const items = [];
  if (!fs.existsSync(root)) return items;
  let groups = [];
  try {
    groups = fs.readdirSync(root, { withFileTypes: true }).filter((c) => c.isDirectory());
  } catch {
    return items;
  }
  for (const group of groups) {
    const groupDir = path.join(root, group.name);
    let children = [];
    try {
      children = fs.readdirSync(groupDir, { withFileTypes: true }).filter((c) => c.isDirectory());
    } catch {
      continue;
    }
    for (const child of children) {
      const full = path.join(groupDir, child.name);
      const rec = describeDir(full, {
        installTo: 'Mods',
        enabled: false,
        stashRoot: groupDir,
      });
      // 用禁用库里的元数据纠正 installTo
      rec.installTo = rec.installTo || 'Mods';
      rec.disabled = true;
      items.push(rec);
    }
  }
  return items;
}

/** 已安装 + 已禁用合并列表 */
function listAll() {
  const paths = getPaths();
  if (!paths.valid) return { valid: false, reason: paths.reason, items: [], totalSize: 0 };
  const items = [...scanEnabled(paths), ...scanDisabled()];
  const totalSize = items.reduce((s, i) => s + (i.size || 0), 0);
  return {
    valid: true,
    addons: paths.addons,
    items,
    totalSize,
    counts: {
      enabled: items.filter((i) => i.enabled).length,
      disabled: items.filter((i) => !i.enabled).length,
      manual: items.filter((i) => i.manual).length,
    },
  };
}

/** 与源清单比对，找出可更新项 */
function withUpdates(items, catalogEntries) {
  const map = new Map(catalogEntries.map((e) => [String(e.id), e]));
  return items.map((item) => {
    const remote = map.get(String(item.id));
    if (!remote) return { ...item, latestVersion: '', updatable: false, remote: null };
    const updatable =
      !!item.version &&
      compareVersion(remote.version, item.version) > 0 &&
      !!remote.downloadUrl;
    return {
      ...item,
      latestVersion: remote.version,
      updatable,
      remote: { id: remote.id, version: remote.version, size: remote.size, downloadUrl: remote.downloadUrl },
    };
  });
}

/** 已安装 id 列表，供依赖判断 */
function installedIds() {
  const r = listAll();
  return r.items.filter((i) => i.enabled).map((i) => String(i.id));
}

module.exports = { init, listAll, withUpdates, installedIds, scanEnabled, scanDisabled, sanitizeDirName };
