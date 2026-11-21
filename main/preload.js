'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 只暴露白名单方法，渲染层拿不到 ipcRenderer 本体 */
const api = {
  appInfo: () => ipcRenderer.invoke('app:info'),

  settings: {
    save: (patch) => ipcRenderer.invoke('settings:save', patch),
  },

  auth: {
    state: () => ipcRenderer.invoke('auth:state'),
    save: (platform, token) => ipcRenderer.invoke('auth:save', { platform, token }),
    clear: (platform) => ipcRenderer.invoke('auth:clear', platform),
    test: (platform) => ipcRenderer.invoke('auth:test', platform),
    gitRead: (platform) => ipcRenderer.invoke('auth:gitRead', platform),
    gitWrite: (platform, username, token) =>
      ipcRenderer.invoke('auth:gitWrite', { platform, username, token }),
  },

  game: {
    detect: () => ipcRenderer.invoke('game:detect'),
    validate: (dir) => ipcRenderer.invoke('game:validate', dir),
    choose: () => ipcRenderer.invoke('game:choose'),
    open: (which) => ipcRenderer.invoke('game:open', which),
  },

  sources: {
    list: () => ipcRenderer.invoke('sources:list'),
    add: (input) => ipcRenderer.invoke('sources:add', input),
    remove: (id) => ipcRenderer.invoke('sources:remove', id),
    update: (id, patch) => ipcRenderer.invoke('sources:update', { id, patch }),
  },

  catalog: {
    refresh: (opts) => ipcRenderer.invoke('catalog:refresh', opts),
    search: (query) => ipcRenderer.invoke('catalog:search', query),
    stats: () => ipcRenderer.invoke('catalog:stats'),
    clear: () => ipcRenderer.invoke('catalog:clear'),
    detail: (id) => ipcRenderer.invoke('catalog:detail', id),
  },

  download: {
    start: (id) => ipcRenderer.invoke('download:start', id),
    startMany: (ids) => ipcRenderer.invoke('download:startMany', ids),
    list: () => ipcRenderer.invoke('download:list'),
    pause: (taskId) => ipcRenderer.invoke('download:pause', taskId),
    resume: (taskId) => ipcRenderer.invoke('download:resume', taskId),
    cancel: (taskId) => ipcRenderer.invoke('download:cancel', taskId),
    pauseAll: () => ipcRenderer.invoke('download:pauseAll'),
    resumeAll: () => ipcRenderer.invoke('download:resumeAll'),
    clear: () => ipcRenderer.invoke('download:clear'),
  },

  local: {
    list: () => ipcRenderer.invoke('local:list'),
    toggle: (id, enabled) => ipcRenderer.invoke('local:toggle', { id, enabled }),
    uninstall: (id) => ipcRenderer.invoke('local:uninstall', id),
    rollback: (id) => ipcRenderer.invoke('local:rollback', id),
    backups: (id) => ipcRenderer.invoke('local:backups', id),
    open: (id) => ipcRenderer.invoke('local:open', id),
    updateOne: (id) => ipcRenderer.invoke('local:updateOne', id),
  },

  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },

  cache: {
    clean: () => ipcRenderer.invoke('cache:clean'),
  },

  win: {
    control: (action) => ipcRenderer.invoke('win:control', action),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  },

  on: (channel, handler) => {
    const allowed = ['evt:task', 'evt:log', 'evt:installed', 'evt:window'];
    if (!allowed.includes(channel)) throw new Error('不允许订阅该事件：' + channel);
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('isElectron', true);
