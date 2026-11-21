'use strict';

const fs = require('fs');
const path = require('path');
const zipUtil = require('./zip');
const logger = require('./logger');

const META_FILE = '.neon-mod.json';
const BACKUP_KEEP = 5;

let userDataDir = null;
let getPaths = () => ({ valid: false, addons: '', mods: '', assets: '', maps: '' });

function init({ userDataDir: dir, getPaths: gp }) {
  userDataDir = dir;
  if (gp) getPaths = gp;
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'disabled'), { recursive: true });
}

function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]+/g, '_').slice(0, 80) || 'mod';
}

function sanitizeDirName(name) {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 64) || 'NeonMod';
}

/** 确保目标路径始终位于 root 之内 */
function assertInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('安装路径越界，已拒绝');
  }
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const item of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!item.isFile()) continue;
      const full = path.join(item.parentPath || item.path, item.name);
      try {
        total += fs.statSync(full).size;
      } catch {
        /* 忽略单个文件错误 */
      }
    }
  } catch {
    /* 忽略 */
  }
  return total;
}

function findDll(dir) {
  try {
    for (const item of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (item.isFile() && /\.dll$/i.test(item.name)) {
        return path.join(item.parentPath || item.path, item.name);
      }
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

function targetPathFor(entry) {
  const paths = getPaths();
  if (!paths.valid) throw new Error(paths.reason || '未配置天际线数据目录，请到设置页指定');

  const installTo = ['Mods', 'Assets', 'Maps'].includes(entry.installTo) ? entry.installTo : 'Mods';
  const baseDir = installTo === 'Assets' ? paths.assets : installTo === 'Maps' ? paths.maps : paths.mods;
  if (!baseDir) throw new Error('游戏目录无效');

  const rawName = String(entry.dirName || entry.name || '');
  // 目录名里出现路径分隔符或 .. 直接拒绝，而不是悄悄清洗成别的目录
  if (/[\\/]/.test(rawName) || rawName.includes('..')) {
    throw new Error(`安装目录名非法：${rawName}`);
  }
  const dirName = sanitizeDirName(rawName);
  const target = path.join(baseDir, dirName);
  assertInside(paths.addons, target);
  return { target, baseDir, installTo, dirName, addons: paths.addons };
}

/** 安装：解压 → 校验 → 备份旧版本 → 落盘 → 写元数据 */
async function install(entry, zipPath) {
  if (!fs.existsSync(zipPath)) throw new Error('安装包不存在，可能已过期');

  const { target, baseDir, installTo, dirName, addons } = targetPathFor(entry);
  const tempDir = path.join(userDataDir, 'tmp', `${safeId(entry.id)}-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // 先列出条目做安全校验，再流式解压（zip slip 防护）
    const entries = await zipUtil.list(zipPath);
    if (!entries.length) throw new Error('压缩包为空');
    const files = await zipUtil.extract(zipPath, tempDir);
    logger.info('install', `解压完成 ${entry.name}（${entries.length} 个条目 / ${files} 个文件）`);

    // 常见打包方式：zip 内只有一个顶层目录
    let contentRoot = tempDir;
    const children = fs
      .readdirSync(tempDir, { withFileTypes: true })
      .filter((c) => c.name !== '__MACOSX');
    if (children.length === 1 && children[0].isDirectory()) {
      contentRoot = path.join(tempDir, children[0].name);
    }

    const hasDll = !!findDll(contentRoot);
    if (installTo === 'Mods' && !hasDll) {
      logger.warn('install', `${entry.name} 的压缩包内没有 .dll，仍按文件夹安装`);
    }

    fs.mkdirSync(baseDir, { recursive: true });

    // 覆盖前备份
    let backup = '';
    if (fs.existsSync(target)) {
      backup = backupDir(entry, target, installTo);
    }

    // 清理后重新铺开，避免残留旧版本文件
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(contentRoot, target, { recursive: true });
    assertInside(addons, target);

    const meta = {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      author: entry.author || '',
      type: entry.type || 'mod',
      installTo,
      dirName,
      deps: entry.deps || [],
      tags: entry.tags || [],
      description: entry.description || '',
      homepage: entry.homepage || '',
      sourceId: entry.sourceId || '',
      sourceLabel: entry.sourceLabel || '',
      platform: entry.platform || '',
      origin: entry.origin || '',
      installedAt: new Date().toISOString(),
      zip: path.basename(zipPath),
      hasDll,
    };
    fs.writeFileSync(path.join(target, META_FILE), JSON.stringify(meta, null, 2), 'utf8');

    logger.info('install', `已安装 ${entry.name} v${entry.version} → ${target}`);
    return { ok: true, target, dirName, installTo, backup, hasDll, size: dirSize(target), meta };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响安装结果 */
    }
  }
}

/** 备份：整目录复制到 userData/backups/<id>/<installTo>-<version>-<时间戳> */
function backupDir(entry, target, installTo) {
  const root = path.join(userDataDir, 'backups', safeId(entry.id));
  fs.mkdirSync(root, { recursive: true });
  const name = `${installTo}-${sanitizeDirName(entry.version || 'old')}-${Date.now()}`;
  const dest = path.join(root, name);
  try {
    fs.cpSync(target, dest, { recursive: true });
    pruneBackups(root);
    logger.info('install', `已备份旧版本 ${entry.name} → ${name}`);
    return dest;
  } catch (e) {
    logger.warn('install', '备份失败（继续安装）：' + e.message);
    return '';
  }
}

function pruneBackups(root) {
  try {
    const dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, t: fs.statSync(path.join(root, d.name)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const item of dirs.slice(BACKUP_KEEP)) {
      fs.rmSync(path.join(root, item.name), { recursive: true, force: true });
    }
  } catch {
    /* 忽略 */
  }
}

function listBackups(id) {
  const root = path.join(userDataDir, 'backups', safeId(id));
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const full = path.join(root, d.name);
        const st = fs.statSync(full);
        return { path: full, name: d.name, size: dirSize(full), time: st.mtimeMs };
      })
      .sort((a, b) => b.time - a.time);
  } catch {
    return [];
  }
}

/** 回滚到最近一次备份 */
function rollback(record) {
  const backups = listBackups(record.id);
  if (!backups.length) throw new Error('没有可用的备份');
  const latest = backups[0];
  const { target, baseDir, installTo, dirName, addons } = targetPathFor({
    installTo: record.installTo,
    dirName: record.dirName,
    name: record.name,
  });

  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(baseDir, { recursive: true });
  fs.cpSync(latest.path, target, { recursive: true });
  assertInside(addons, target);

  logger.info('install', `已回滚 ${record.name}（${latest.name}）`);
  return { ok: true, target, dirName, installTo, backup: latest.path };
}

/** 卸载：可选先备份，再删除目录 */
function uninstall(record, { backup = true } = {}) {
  const { target } = targetPathFor(record);
  let saved = '';
  if (fs.existsSync(target)) {
    if (backup) saved = backupDir(record, target, record.installTo || 'Mods');
    fs.rmSync(target, { recursive: true, force: true });
  }
  logger.info('install', `已卸载 ${record.name}${saved ? '（已备份）' : ''}`);
  return { ok: true, target, backup: saved };
}

/** 禁用：移动到 userData/disabled；启用：移回 */
function setEnabled(record, enabled) {
  const { target, baseDir, dirName } = targetPathFor(record);
  const stash = path.join(userDataDir, 'disabled', safeId(record.id));
  const stashDir = path.join(stash, dirName);

  if (!enabled) {
    if (!fs.existsSync(target)) throw new Error('该目录已不存在，可能已被手动删除');
    fs.mkdirSync(stash, { recursive: true });
    if (fs.existsSync(stashDir)) fs.rmSync(stashDir, { recursive: true, force: true });
    fs.renameSync(target, stashDir);
    logger.info('install', `已禁用 ${record.name}（移至 ${stashDir}）`);
    return { ok: true, enabled: false, path: stashDir };
  }

  if (!fs.existsSync(stashDir)) throw new Error('找不到已禁用的目录，请重新安装');
  fs.mkdirSync(baseDir, { recursive: true });
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(stashDir, target);
  logger.info('install', `已启用 ${record.name}`);
  return { ok: true, enabled: true, path: target };
}

function cleanCache() {
  let freed = 0;
  for (const sub of ['tmp', 'downloads']) {
    const dir = path.join(userDataDir, sub);
    try {
      freed += dirSize(dir);
      for (const item of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, item), { recursive: true, force: true });
      }
    } catch {
      /* 忽略 */
    }
  }
  return { ok: true, freed };
}

module.exports = {
  init,
  install,
  uninstall,
  rollback,
  setEnabled,
  listBackups,
  cleanCache,
  dirSize,
  findDll,
  sanitizeDirName,
  assertSafeEntry: zipUtil.assertSafeEntry,
  META_FILE,
};
