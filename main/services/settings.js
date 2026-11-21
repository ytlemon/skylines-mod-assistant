'use strict';

const fs = require('fs');
const path = require('path');

/** 默认设置（首次启动写入） */
const DEFAULTS = {
  addonsPath: '', // 例如 C:\Users\xx\AppData\Local\Colossal Order\Cities_Skylines
  mirror: '', // GitHub 加速前缀，如 https://ghfast.top/ ，留空表示直连
  concurrency: 3,
  theme: 'cyan', // cyan | magenta
  sources: [],
  credentials: { github: '', gitee: '' }, // 内存中为明文，落盘前加密
};

let file = null;
let cache = null;

/* ------------------------------ 凭据加密 ------------------------------ */
// 优先用 Electron safeStorage（Windows 下走 DPAPI），拿不到时退化为 base64 混淆。
function getSafeStorage() {
  try {
    // 在纯 Node 环境（自检脚本）里 require('electron') 返回的是路径字符串
    const electron = require('electron');
    if (electron && electron.safeStorage && electron.safeStorage.isEncryptionAvailable()) {
      return electron.safeStorage;
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

function encodeSecret(value) {
  const v = String(value || '');
  if (!v) return '';
  try {
    const ss = getSafeStorage();
    if (ss) return 'enc:' + ss.encryptString(v).toString('base64');
  } catch {
    /* 加密失败时退回明文存储，避免丢配置 */
  }
  return 'plain:' + Buffer.from(v, 'utf8').toString('base64');
}

function decodeSecret(value) {
  const v = String(value || '');
  if (!v) return '';
  try {
    if (v.startsWith('enc:')) {
      const ss = getSafeStorage();
      if (!ss) return '';
      return ss.decryptString(Buffer.from(v.slice(4), 'base64'));
    }
    if (v.startsWith('plain:')) {
      return Buffer.from(v.slice(6), 'base64').toString('utf8');
    }
  } catch {
    return '';
  }
  return v; // 兼容旧版本明文
}

/* ------------------------------ 读写 ------------------------------ */
function init(userDataDir) {
  file = path.join(userDataDir, 'settings.json');
  cache = load();
  return cache;
}

function sanitizeSource(src, index) {
  const platform = src.platform === 'gitee' ? 'gitee' : 'github';
  const owner = String(src.owner || '').trim().replace(/^\/+|\/+$/g, '');
  const repo = String(src.repo || '').trim().replace(/^\/+|\/+$/g, '');
  if (!owner || !repo) throw new Error('源必须包含 owner 与 repo');
  if (/[\s/\\]/.test(owner) || /[\s/\\]/.test(repo)) throw new Error('owner / repo 不能包含空格或斜杠');
  return {
    id: src.id || `${platform}:${owner}/${repo}`,
    platform,
    owner,
    repo,
    branch: String(src.branch || 'main').trim() || 'main',
    mode: src.mode === 'releases' ? 'releases' : 'manifest',
    enabled: src.enabled !== false,
    addedAt: src.addedAt || Date.now(),
    order: typeof src.order === 'number' ? src.order : index,
  };
}

function load() {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return normalize({ ...DEFAULTS, ...data });
  } catch {
    return normalize({ ...DEFAULTS });
  }
}

function normalize(data) {
  const out = { ...DEFAULTS, ...data };
  out.concurrency = Math.min(6, Math.max(1, Number(out.concurrency) || 3));
  out.mirror = typeof out.mirror === 'string' ? out.mirror.trim() : '';
  out.theme = out.theme === 'magenta' ? 'magenta' : 'cyan';
  out.sources = Array.isArray(out.sources) ? out.sources : [];
  out.sources = out.sources
    .map((s, i) => {
      try {
        return sanitizeSource(s, i);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  // 旧版本只存了一个 token，迁移成 GitHub 凭据
  const legacy = typeof data.token === 'string' ? data.token : '';
  const creds = data.credentials && typeof data.credentials === 'object' ? data.credentials : {};
  out.credentials = {
    github: decodeSecret(creds.github || legacy || ''),
    gitee: decodeSecret(creds.gitee || ''),
  };
  delete out.token;
  return out;
}

function get() {
  if (!cache) throw new Error('settings 未初始化');
  return cache;
}

function save(patch) {
  const merged = {
    ...cache,
    ...patch,
    sources: patch.sources ? patch.sources : cache.sources,
    credentials: { ...cache.credentials, ...(patch.credentials || {}) },
  };
  cache = normalize(merged);
  persist();
  return cache;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const onDisk = {
      addonsPath: cache.addonsPath,
      mirror: cache.mirror,
      concurrency: cache.concurrency,
      theme: cache.theme,
      sources: cache.sources,
      credentials: {
        github: encodeSecret(cache.credentials.github),
        gitee: encodeSecret(cache.credentials.gitee),
      },
    };
    fs.writeFileSync(file, JSON.stringify(onDisk, null, 2), 'utf8');
  } catch (e) {
    throw new Error('保存设置失败：' + e.message);
  }
}

/* ------------------------------ 凭据操作 ------------------------------ */
const PLATFORMS = ['github', 'gitee'];

function setCredential(platform, token) {
  if (!PLATFORMS.includes(platform)) throw new Error('未知平台：' + platform);
  const value = String(token || '').trim();
  if (!value) throw new Error('密钥不能为空');
  if (value.includes('\n') || value.includes(' ')) throw new Error('密钥格式不正确（含空格或换行）');
  settingsCredentials()[platform] = value;
  persist();
  return credentialState();
}

function clearCredential(platform) {
  if (!PLATFORMS.includes(platform)) throw new Error('未知平台：' + platform);
  settingsCredentials()[platform] = '';
  persist();
  return credentialState();
}

function getCredential(platform) {
  return (cache && cache.credentials && cache.credentials[platform]) || '';
}

function settingsCredentials() {
  if (!cache.credentials) cache.credentials = { github: '', gitee: '' };
  return cache.credentials;
}

/** 给渲染层用的状态：只暴露有没有，不返回明文 */
function credentialState() {
  const c = (cache && cache.credentials) || {};
  return {
    github: { saved: !!c.github, hint: c.github ? mask(c.github) : '' },
    gitee: { saved: !!c.gitee, hint: c.gitee ? mask(c.gitee) : '' },
    encrypted: !!getSafeStorage(),
  };
}

function mask(secret) {
  const s = String(secret);
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

/* ------------------------------ 源操作 ------------------------------ */
function addSource(input) {
  const list = cache.sources.slice();
  const src = sanitizeSource(input, list.length);
  const dup = list.findIndex((s) => s.id === src.id);
  if (dup >= 0) {
    list[dup] = { ...list[dup], ...src, addedAt: list[dup].addedAt };
  } else {
    list.push(src);
  }
  return save({ sources: list });
}

function removeSource(id) {
  return save({ sources: cache.sources.filter((s) => s.id !== id) });
}

function updateSource(id, patch) {
  const list = cache.sources.map((s) =>
    s.id === id ? sanitizeSource({ ...s, ...patch }, s.order || 0) : s
  );
  return save({ sources: list });
}

module.exports = {
  init,
  get,
  save,
  addSource,
  removeSource,
  updateSource,
  sanitizeSource,
  setCredential,
  clearCredential,
  getCredential,
  credentialState,
  PLATFORMS,
  DEFAULTS,
  get file() {
    return file;
  },
};
