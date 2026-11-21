'use strict';

const fs = require('fs');
const path = require('path');

const GAME_FOLDER = 'Colossal Order/Cities_Skylines';
const SUB_DIRS = { Mods: 'Mods', Assets: 'Assets', Maps: 'Maps' };

/** 候选的天际线用户数据目录 */
function candidates() {
  const list = [];
  const push = (p) => {
    if (p) list.push(path.normalize(p));
  };
  if (process.env.LOCALAPPDATA) {
    push(path.join(process.env.LOCALAPPDATA, GAME_FOLDER));
    push(path.join(process.env.LOCALAPPDATA, 'Colossal Order', 'Cities_Skylines'));
  }
  if (process.env.USERPROFILE) {
    push(path.join(process.env.USERPROFILE, 'AppData', 'Local', GAME_FOLDER));
    // 部分环境把用户数据放在 Documents 下的兼容路径
    push(path.join(process.env.USERPROFILE, 'Documents', GAME_FOLDER));
  }
  return [...new Set(list)];
}

/** 判定某个目录是不是有效的天际线数据目录：存在且含 Addons */
function validate(dir) {
  if (!dir) return { ok: false, reason: '未配置目录' };
  try {
    const addons = path.join(dir, 'Addons');
    if (!fs.existsSync(addons)) return { ok: false, reason: '该目录下没有 Addons 文件夹' };
    fs.accessSync(addons, fs.constants.W_OK);
    return { ok: true, addons };
  } catch (e) {
    return { ok: false, reason: e.code === 'EACCES' ? '没有写入权限' : e.message };
  }
}

/** 自动探测，返回 { path, detected, candidates } */
function detect() {
  for (const dir of candidates()) {
    const v = validate(dir);
    if (v.ok) return { path: dir, detected: true, addons: v.addons, candidates: candidates() };
  }
  return { path: '', detected: false, candidates: candidates() };
}

/** 解析出实际要用的数据目录（允许设置里手动指定） */
function resolve(configured) {
  if (configured) {
    const v = validate(configured);
    if (!v.ok) {
      return {
        path: '',
        valid: false,
        reason: v.reason,
        detected: detect(),
      };
    }
    return { path: configured, valid: true, addons: v.addons, detected: detect() };
  }
  const d = detect();
  return { path: d.path, valid: !!d.path, addons: d.addons, reason: d.path ? '' : '未检测到天际线用户数据目录', detected: d };
}

function paths(configured) {
  const r = resolve(configured);
  if (!r.valid) return { ...r, mods: '', assets: '', maps: '', addons: '' };
  const addons = path.join(r.path, 'Addons');
  return {
    ...r,
    addons,
    mods: path.join(addons, SUB_DIRS.Mods),
    assets: path.join(addons, SUB_DIRS.Assets),
    maps: path.join(addons, SUB_DIRS.Maps),
  };
}

/** 确保目标子目录存在 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { detect, resolve, validate, paths, ensureDir, candidates, SUB_DIRS, GAME_FOLDER };
