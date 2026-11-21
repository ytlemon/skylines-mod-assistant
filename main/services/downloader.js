'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { request } = require('./http');
const logger = require('./logger');

const MAX_RETRY = 3;
const EMIT_INTERVAL = 200;
const SPEED_WINDOW = 800;

function hashId(id) {
  return crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 12);
}

function applyMirror(url, mirror) {
  const m = String(mirror || '').trim();
  if (!m) return url;
  const prefix = m.endsWith('/') ? m : m + '/';
  if (
    /^https?:\/\/(github\.com|raw\.githubusercontent\.com|objects\.githubusercontent\.com|codeload\.github\.com|api\.github\.com)\//i.test(
      url
    )
  ) {
    return prefix + url.replace(/^https?:\/\//, '');
  }
  return url;
}

class Downloader extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
    this.active = new Set();
    this.pausedAll = false;
    this.userDataDir = null;
    this.getSettings = () => ({ concurrency: 3, mirror: '' });
    this.installHandler = null;
    this.seq = 0;
  }

  init({ userDataDir, getSettings, installHandler }) {
    this.userDataDir = userDataDir;
    this.getSettings = getSettings || this.getSettings;
    this.installHandler = installHandler || null;
    this.downloadDir = path.join(userDataDir, 'downloads');
    fs.mkdirSync(this.downloadDir, { recursive: true });
  }

  setInstallHandler(fn) {
    this.installHandler = fn;
  }

  snapshot() {
    return [...this.tasks.values()].map((t) => this.publicTask(t));
  }

  publicTask(t) {
    return {
      taskId: t.taskId,
      id: t.entry.id,
      name: t.entry.name,
      version: t.entry.version,
      status: t.status,
      received: t.received,
      total: t.total,
      speed: t.speed,
      percent: t.total ? Math.min(100, (t.received / t.total) * 100) : 0,
      error: t.error,
      attempts: t.attempts,
      autoInstall: t.autoInstall,
      url: t.entry.downloadUrl,
      startedAt: t.startedAt || 0,
      finishedAt: t.finishedAt || 0,
    };
  }

  emitTask(t, force = false) {
    const now = Date.now();
    if (!force && now - (t.lastEmit || 0) < EMIT_INTERVAL) return;
    t.lastEmit = now;
    this.emit('task', this.publicTask(t));
  }

  /** 入队，返回 taskId；同 id 已存在且未完成时直接复用 */
  enqueue(entry, { autoInstall = true } = {}) {
    const exist = [...this.tasks.values()].find(
      (t) => String(t.entry.id) === String(entry.id) && !['done', 'error', 'canceled'].includes(t.status)
    );
    if (exist) return exist.taskId;

    const taskId = `t${++this.seq}`;
    const task = {
      taskId,
      entry,
      status: 'queued',
      received: 0,
      total: entry.size || 0,
      speed: 0,
      receivedAtStart: 0,
      attempts: 0,
      autoInstall,
      error: '',
      partPath: path.join(this.downloadDir, `${hashId(entry.id)}.part`),
      zipPath: path.join(this.downloadDir, `${hashId(entry.id)}.zip`),
      aborted: false,
      paused: false,
      lastEmit: 0,
      startedAt: 0,
      finishedAt: 0,
    };
    this.tasks.set(taskId, task);
    logger.info('download', `入队 ${entry.name} v${entry.version}`, entry.downloadUrl);
    this.emitTask(task, true);
    this.pump();
    return taskId;
  }

  pump() {
    if (this.pausedAll) return;
    const limit = Math.min(6, Math.max(1, Number(this.getSettings().concurrency) || 3));
    for (const task of this.tasks.values()) {
      if (this.active.size >= limit) break;
      if (task.status === 'queued' && !this.active.has(task.taskId)) {
        this.active.add(task.taskId);
        this.run(task).finally(() => {
          this.active.delete(task.taskId);
          this.pump();
        });
      }
    }
  }

  async run(task) {
    task.status = 'downloading';
    task.startedAt = task.startedAt || Date.now();
    this.emitTask(task, true);

    try {
      await this.downloadWithRetry(task);
      if (task.status === 'paused' || task.status === 'canceled') return;

      task.status = 'verifying';
      this.emitTask(task, true);
      await this.verify(task);
      if (task.status === 'paused' || task.status === 'canceled') return;

      if (task.autoInstall && this.installHandler) {
        task.status = 'installing';
        task.received = task.total || task.received;
        this.emitTask(task, true);
        await this.installHandler(task.entry, task.zipPath, task);
        if (task.status === 'canceled') return;
      }

      task.status = 'done';
      task.speed = 0;
      task.finishedAt = Date.now();
      logger.info('download', `完成 ${task.entry.name} v${task.entry.version}`);
    } catch (e) {
      if (task.status === 'paused' || task.status === 'canceled') return;
      task.status = 'error';
      task.speed = 0;
      task.error = e.message || String(e);
      logger.error('download', `失败 ${task.entry.name}：${task.error}`);
    }
    this.emitTask(task, true);
  }

  async downloadWithRetry(task) {
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      if (task.paused || task.aborted) return;
      task.attempts = attempt + 1;
      try {
        await this.downloadOnce(task);
        return;
      } catch (e) {
        lastErr = e;
        if (task.paused || task.aborted) return;
        // 4xx 属于永久性错误（404 不存在、403 无权限），重试没有意义
        const code = e.statusCode || 0;
        if (code >= 400 && code < 500 && code !== 408 && code !== 429) break;
        if (attempt === MAX_RETRY) break;
        const wait = 800 * Math.pow(2, attempt);
        logger.warn('download', `${task.entry.name} 第 ${attempt + 1} 次失败：${e.message}，${wait}ms 后重试`);
        task.error = e.message;
        this.emitTask(task, true);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr || new Error('下载失败');
  }

  async downloadOnce(task) {
    const settings = this.getSettings();
    const targetUrl = applyMirror(task.entry.downloadUrl, settings.mirror);
    if (targetUrl !== task.entry.downloadUrl) {
      task.viaMirror = true;
    }

    let startFrom = 0;
    try {
      const st = fs.statSync(task.partPath);
      startFrom = st.size;
    } catch {
      startFrom = 0;
    }

    const headers = {};
    if (startFrom > 0) headers.Range = `bytes=${startFrom}-`;

    const res = await request(targetUrl, { headers, timeout: 45000 });
    const code = res.statusCode || 0;

    if (code === 416) {
      // 断点已到文件末尾，直接视作完成
      res.resume();
      task.received = startFrom;
      task.total = startFrom;
      try {
        fs.renameSync(task.partPath, task.zipPath);
      } catch {
        throw new Error('断点文件转换失败，请重试');
      }
      return;
    }
    if (code >= 400) {
      res.resume();
      const err = new Error(`下载失败 HTTP ${code}`);
      err.statusCode = code;
      throw err;
    }

    let append = false;
    if (code === 206) {
      append = true;
      const range = String(res.headers['content-range'] || '');
      const m = range.match(/\/(\d+)$/);
      if (m) task.total = Number(m[1]);
    } else {
      // 服务器不支持断点：重头下载
      startFrom = 0;
      const len = Number(res.headers['content-length']);
      if (len > 0) task.total = len;
    }

    task.received = startFrom;
    task.receivedAtStart = startFrom;
    fs.mkdirSync(path.dirname(task.partPath), { recursive: true });

    const ws = fs.createWriteStream(task.partPath, { flags: append ? 'a' : 'w' });
    // 记录当前请求，暂停/取消时可立即中断
    task.currentRes = res;
    task.currentWs = ws;

    try {
    await new Promise((resolve, reject) => {
      let lastTick = Date.now();
      let lastBytes = task.received;

      const speedTimer = setInterval(() => {
        const now = Date.now();
        const dt = (now - lastTick) / 1000;
        if (dt > 0) {
          const delta = task.received - lastBytes;
          const inst = delta / dt;
          task.speed = task.speed ? task.speed * 0.4 + inst * 0.6 : inst;
        }
        lastTick = now;
        lastBytes = task.received;
        this.emitTask(task);
      }, SPEED_WINDOW);

      const cleanup = () => clearInterval(speedTimer);

      res.on('data', (chunk) => {
        task.received += chunk.length;
      });
      res.on('error', (e) => {
        cleanup();
        reject(e);
      });
      ws.on('error', (e) => {
        cleanup();
        reject(e);
      });
      ws.on('finish', () => {
        cleanup();
        resolve();
      });
      res.pipe(ws);
    });
    } finally {
      task.currentRes = null;
      task.currentWs = null;
    }

    if (task.total && task.received < task.total) {
      throw new Error(`连接提前中断（${task.received}/${task.total} 字节）`);
    }

    // 落盘完成后从 .part 转正
    try {
      fs.renameSync(task.partPath, task.zipPath);
    } catch (e) {
      throw new Error('写入安装包失败：' + e.message);
    }
    task.received = task.total = task.received;
    this.emitTask(task, true);
  }

  async verify(task) {
    if (!task.entry.sha256) return;
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(task.zipPath);
      rs.on('data', (c) => hash.update(c));
      rs.on('end', resolve);
      rs.on('error', reject);
    });
    const got = hash.digest('hex');
    if (got !== task.entry.sha256) {
      try {
        fs.unlinkSync(task.zipPath);
      } catch {
        /* 忽略 */
      }
      throw new Error(`校验失败：sha256 不匹配（期望 ${task.entry.sha256.slice(0, 12)}… 实际 ${got.slice(0, 12)}…）`);
    }
  }

  /** 中断当前网络流（保留 .part 以便续传） */
  abortStream(t) {
    if (t.currentWs) {
      try {
        t.currentWs.destroy();
      } catch {
        /* 忽略 */
      }
    }
    if (t.currentRes) {
      try {
        t.currentRes.destroy(new Error('aborted'));
      } catch {
        /* 忽略 */
      }
    }
  }

  pause(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    if (t.status === 'downloading') {
      t.paused = true;
      t.status = 'paused';
      t.speed = 0;
      this.abortStream(t);
      this.emitTask(t, true);
      return true;
    }
    if (t.status === 'queued') {
      t.status = 'paused';
      this.emitTask(t, true);
      return true;
    }
    return false;
  }

  resume(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    if (t.status === 'paused') {
      t.paused = false;
      t.status = 'queued';
      this.emitTask(t, true);
      this.pump();
      return true;
    }
    if (t.status === 'error') {
      t.error = '';
      t.attempts = 0;
      t.status = 'queued';
      this.emitTask(t, true);
      this.pump();
      return true;
    }
    return false;
  }

  cancel(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    t.aborted = true;
    t.status = 'canceled';
    t.speed = 0;
    this.abortStream(t);
    this.emitTask(t, true);
    setTimeout(() => this.tasks.delete(taskId), 500);
    return true;
  }

  pauseAll() {
    this.pausedAll = true;
    for (const t of this.tasks.values()) {
      if (t.status === 'queued') {
        t.status = 'paused';
        this.emitTask(t, true);
      }
    }
    return true;
  }

  resumeAll() {
    this.pausedAll = false;
    for (const t of this.tasks.values()) {
      if (t.status === 'paused') {
        t.paused = false;
        t.status = 'queued';
        this.emitTask(t, true);
      }
    }
    this.pump();
    return true;
  }

  clearFinished() {
    for (const [id, t] of this.tasks) {
      if (['done', 'error', 'canceled'].includes(t.status)) this.tasks.delete(id);
    }
    return this.snapshot();
  }
}

module.exports = new Downloader();
module.exports.applyMirror = applyMirror;
