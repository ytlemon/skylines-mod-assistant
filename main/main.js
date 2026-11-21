'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const http = require('./services/http');
const logger = require('./services/logger');
const settings = require('./services/settings');
const gamepath = require('./services/gamepath');
const catalog = require('./services/catalog');
const downloader = require('./services/downloader');
const installer = require('./services/installer');
const local = require('./services/local');

const isDev = process.argv.includes('--dev');
let win = null;
let getPaths = () => ({ valid: false });

/* ---------------------------------- 单实例 --------------------------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

/* ---------------------------------- 服务初始化 -------------------------------- */
function bootstrap() {
  const userDataDir = app.getPath('userData');
  fs.mkdirSync(userDataDir, { recursive: true });

  logger.init(userDataDir, (entry) => {
    if (win && !win.isDestroyed()) win.webContents.send('evt:log', entry);
  });

  settings.init(userDataDir);

  // 首次启动自动探测游戏目录并持久化，省去用户手动选择
  const st = settings.get();
  if (!st.addonsPath) {
    const d = gamepath.detect();
    if (d.path) {
      settings.save({ addonsPath: d.path });
      logger.info('boot', `自动探测到天际线数据目录：${d.path}`);
    } else {
      logger.warn('boot', '未探测到天际线数据目录，需在设置页手动指定');
    }
  }

  const paths = () => gamepath.paths(settings.get().addonsPath);
  getPaths = paths;

  installer.init({ userDataDir, getPaths: paths });
  local.init({ userDataDir, getPaths: paths });
  catalog.init(userDataDir, () => settings.get());
  downloader.init({
    userDataDir,
    getSettings: () => {
      const s = settings.get();
      return { concurrency: s.concurrency, mirror: s.mirror };
    },
    installHandler: async (entry, zipPath) => {
      const res = await installer.install(entry, zipPath);
      if (win && !win.isDestroyed()) {
        win.webContents.send('evt:installed', { id: entry.id, name: entry.name, version: entry.version });
      }
      return res;
    },
  });

  downloader.on('task', (task) => {
    if (win && !win.isDestroyed()) win.webContents.send('evt:task', task);
  });

  logger.info('boot', `应用启动 v${app.getVersion()}，用户数据目录 ${userDataDir}`);
}

/* ---------------------------------- 窗口 ---------------------------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    frame: false,
    backgroundColor: '#05070D',
    show: false,
    title: '天际线 Mod 助手',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.on('maximize', () => send('evt:window', { maximized: true }));
  win.on('unmaximize', () => send('evt:window', { maximized: false }));
  win.on('closed', () => {
    win = null;
  });

  // 外链一律走系统浏览器，禁止在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ---------------------------------- IPC ---------------------------------- */
function registerIpc() {
  ipcMain.handle('app:info', () => {
    const paths = getPaths();
    return {
      version: app.getVersion(),
      userData: app.getPath('userData'),
      // 允许用 `electron . --view=settings` 直接打开设置页（例如只为了填密钥）
      initialView: process.argv.includes('--view=settings') ? 'settings' : 'discover',
      settings: publicSettings(),
      game: {
        valid: paths.valid,
        addonsPath: settings.get().addonsPath,
        reason: paths.reason || '',
        detected: gamepath.detect().path,
        paths: { mods: paths.mods, assets: paths.assets, maps: paths.maps },
      },
      stats: catalog.stats(),
      downloads: downloader.snapshot(),
      logFile: logger.logFile,
    };
  });

  ipcMain.handle('settings:save', (_e, patch) => {
    const next = settings.save(patch || {});
    logger.info('settings', '设置已更新', Object.keys(patch || {}));
    return publicSettings(next);
  });

  ipcMain.handle('game:detect', () => {
    const d = gamepath.detect();
    return { path: d.path, detected: d.detected, candidates: d.candidates };
  });

  ipcMain.handle('game:validate', (_e, dir) => gamepath.validate(dir));

  ipcMain.handle('game:choose', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择天际线用户数据目录（含 Addons 文件夹）',
      properties: ['openDirectory'],
      defaultPath: settings.get().addonsPath || gamepath.detect().path || undefined,
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    const dir = r.filePaths[0];
    const v = gamepath.validate(dir);
    if (!v.ok) return { canceled: false, ok: false, reason: v.reason, path: dir };
    settings.save({ addonsPath: dir });
    logger.info('game', `游戏目录已设置为 ${dir}`);
    return { canceled: false, ok: true, path: dir };
  });

  ipcMain.handle('game:open', (_e, which) => {
    const paths = getPaths();
    const target =
      which === 'mods' ? paths.mods : which === 'assets' ? paths.assets : which === 'addons' ? paths.addons : paths.mods;
    if (!target) throw new Error('游戏目录无效');
    fs.mkdirSync(target, { recursive: true });
    shell.openPath(target);
    return target;
  });

  /* -------------------------------- 密钥 -------------------------------- */
  ipcMain.handle('auth:state', () => settings.credentialState());

  ipcMain.handle('auth:save', (_e, { platform, token }) => {
    const state = settings.setCredential(platform, token);
    logger.info('auth', `已保存 ${platform} 密钥`);
    return state;
  });

  ipcMain.handle('auth:clear', (_e, platform) => {
    const state = settings.clearCredential(platform);
    logger.info('auth', `已清除 ${platform} 密钥`);
    return state;
  });

  // 用真实接口验证密钥是否可用
  ipcMain.handle('auth:test', async (_e, platform) => {
    const token = settings.getCredential(platform);
    if (!token) throw new Error('该平台还没有保存密钥');
    const isGitee = platform === 'gitee';
    const url = isGitee
      ? `https://gitee.com/api/v5/user?access_token=${encodeURIComponent(token)}`
      : 'https://api.github.com/user';
    const headers = isGitee ? {} : { Authorization: `Bearer ${token}` };
    try {
      const data = await http.getJson(url, { headers, timeout: 15000 });
      logger.info('auth', `${platform} 密钥验证通过：${data.login || data.name || ''}`);
      return { ok: true, login: data.login || data.name || '', name: data.name || '' };
    } catch (e) {
      const code = e.statusCode;
      if (code === 401) throw new Error('密钥无效或已过期');
      if (code === 403) throw new Error('权限不足或触发限流（Gitee 需勾选 projects 权限）');
      if (code === 404) throw new Error('接口不可达，可能是网络问题');
      throw new Error(e.message || '验证失败');
    }
  });

  // 从本机 Git 凭据管理器读取
  ipcMain.handle('auth:gitRead', (_e, platform) => {
    const host = gitHost(platform);
    try {
      const out = runGit(['credential', 'fill'], `protocol=https\nhost=${host}\n\n`);
      const cred = parseCredential(out);
      if (!cred.password) {
        throw new Error(`Git 凭据库里没有 ${host} 的密码，请手动填写密钥`);
      }
      return { ok: true, username: cred.username || '', password: cred.password };
    } catch (e) {
      throw new Error(
        /timed? ?out|ETIMEDOUT/i.test(e.message || '')
          ? 'Git 凭据管理器在等待输入，已超时。请手动粘贴密钥'
          : e.message || '读取 Git 凭据失败'
      );
    }
  });

  // 写回本机 Git 凭据管理器（会弹出系统授权窗口的话属正常）
  ipcMain.handle('auth:gitWrite', (_e, { platform, username, token }) => {
    const host = gitHost(platform);
    if (!username || !token) throw new Error('需要用户名与密钥');
    try {
      runGit(
        ['credential', 'approve'],
        `protocol=https\nhost=${host}\nusername=${username}\npassword=${token}\n\n`
      );
      logger.info('auth', `已把 ${host} 凭据写入 Git 凭据管理器`);
      return { ok: true, host };
    } catch (e) {
      throw new Error('写入 Git 凭据失败：' + (e.message || '未知错误'));
    }
  });

  /* --------------------------------- 源 --------------------------------- */
  ipcMain.handle('sources:list', () => settings.get().sources);
  ipcMain.handle('sources:add', (_e, input) => {
    const next = settings.addSource(input || {});
    return next.sources;
  });
  ipcMain.handle('sources:remove', (_e, id) => settings.removeSource(id).sources);
  ipcMain.handle('sources:update', (_e, { id, patch }) => settings.updateSource(id, patch || {}).sources);

  /* ------------------------------- 目录/搜索 ------------------------------- */
  ipcMain.handle('catalog:refresh', (_e, opts) => catalog.refresh({ force: !!(opts && opts.force) }));
  ipcMain.handle('catalog:search', (_e, query) => catalog.search(query || {}));
  ipcMain.handle('catalog:stats', () => catalog.stats());
  ipcMain.handle('catalog:clear', () => {
    catalog.clearCache();
    return true;
  });
  ipcMain.handle('catalog:detail', (_e, id) => {
    const entry = catalog.get(id);
    if (!entry) throw new Error('找不到该 Mod，请刷新源');
    const installed = local.installedIds();
    const deps = catalog.resolveDeps(id, installed);
    const installedItem = local.listAll().items.find((i) => String(i.id) === String(id));
    return { entry, deps, installed: installedItem || null };
  });

  /* --------------------------------- 下载 --------------------------------- */
  ipcMain.handle('download:start', (_e, id) => {
    const entry = catalog.get(id);
    if (!entry) throw new Error('找不到该 Mod，请刷新源');
    if (!entry.downloadUrl) throw new Error('该条目没有下载地址');

    const installed = local.installedIds();
    const deps = catalog.resolveDeps(id, installed);
    const taskIds = [];
    for (const dep of deps.required) {
      const depEntry = catalog.get(dep.id);
      if (depEntry && depEntry.downloadUrl) taskIds.push(downloader.enqueue(depEntry));
    }
    taskIds.push(downloader.enqueue(entry));
    return { ok: true, taskIds, deps: { required: deps.required, missing: deps.missing } };
  });

  ipcMain.handle('download:startMany', (_e, ids) => {
    const list = (ids || []).map((id) => catalog.get(id)).filter(Boolean);
    const out = [];
    for (const entry of list) out.push(downloader.enqueue(entry));
    return { ok: true, taskIds: out };
  });

  ipcMain.handle('download:list', () => downloader.snapshot());
  ipcMain.handle('download:pause', (_e, taskId) => downloader.pause(taskId));
  ipcMain.handle('download:resume', (_e, taskId) => downloader.resume(taskId));
  ipcMain.handle('download:cancel', (_e, taskId) => downloader.cancel(taskId));
  ipcMain.handle('download:pauseAll', () => downloader.pauseAll());
  ipcMain.handle('download:resumeAll', () => downloader.resumeAll());
  ipcMain.handle('download:clear', () => downloader.clearFinished());

  /* -------------------------------- 本地管理 ------------------------------- */
  ipcMain.handle('local:list', () => {
    const result = local.listAll();
    const decorated = local.withUpdates(result.items, catalog.all());
    return { ...result, items: decorated };
  });

  ipcMain.handle('local:toggle', (_e, { id, enabled }) => {
    const record = findLocalRecord(id);
    if (!record) throw new Error('本机未找到该 Mod');
    const r = installer.setEnabled(record, !!enabled);
    return r;
  });

  ipcMain.handle('local:uninstall', (_e, id) => {
    const record = findLocalRecord(id);
    if (!record) throw new Error('本机未找到该 Mod');
    return installer.uninstall(record, { backup: true });
  });

  ipcMain.handle('local:rollback', (_e, id) => {
    const record = findLocalRecord(id);
    if (!record) throw new Error('本机未找到该 Mod');
    return installer.rollback(record);
  });

  ipcMain.handle('local:backups', (_e, id) => installer.listBackups(id));

  ipcMain.handle('local:open', (_e, id) => {
    const record = findLocalRecord(id);
    if (record) {
      shell.openPath(record.path);
      return record.path;
    }
    const paths = getPaths();
    if (paths.mods) shell.openPath(paths.mods);
    return paths.mods || '';
  });

  ipcMain.handle('local:updateOne', (_e, id) => {
    const entry = catalog.get(id);
    if (!entry) throw new Error('源中已无该 Mod');
    return { ok: true, taskId: downloader.enqueue(entry) };
  });

  /* --------------------------------- 其他 --------------------------------- */
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('只允许打开 http/https 链接');
    return shell.openExternal(url);
  });

  ipcMain.handle('cache:clean', () => installer.cleanCache());

  ipcMain.handle('win:control', (_e, action) => {
    if (!win) return false;
    if (action === 'min') win.minimize();
    else if (action === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === 'close') win.close();
    return win.isMaximized();
  });

  ipcMain.handle('win:isMaximized', () => (win ? win.isMaximized() : false));
}

/** 给渲染层的设置副本：永远不包含明文密钥 */
function publicSettings(s) {
  const st = s || settings.get();
  const { credentials, ...rest } = st;
  return { ...rest, credentials: settings.credentialState() };
}

/* ------------------------------ Git 凭据辅助 ------------------------------ */
function gitHost(platform) {
  return platform === 'gitee' ? 'gitee.com' : 'github.com';
}

function runGit(args, input) {
  return execFileSync('git', args, {
    input,
    timeout: 15000,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function parseCredential(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function findLocalRecord(id) {
  const r = local.listAll();
  return r.items.find((i) => String(i.id) === String(id)) || null;
}

/* ---------------------------------- 生命周期 -------------------------------- */
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  try {
    bootstrap();
    registerIpc();
    createWindow();
  } catch (e) {
    logger.error('boot', '启动失败：' + e.message);
    dialog.showErrorBox('启动失败', e.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  logger.info('boot', '应用退出');
});
