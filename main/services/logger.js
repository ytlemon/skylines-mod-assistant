'use strict';

const fs = require('fs');
const path = require('path');

const MAX_SIZE = 1024 * 1024; // 1MB 轮转

let logFile = null;
let sink = null; // 渲染层日志回传

function init(dir, onLog) {
  logFile = path.join(dir, 'logs', 'app.log');
  sink = onLog || null;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  } catch {
    /* 日志目录不可用时退化为仅控制台 */
  }
}

function rotate() {
  try {
    const st = fs.statSync(logFile);
    if (st.size > MAX_SIZE) {
      fs.renameSync(logFile, logFile.replace(/\.log$/, '.1.log'));
    }
  } catch {
    /* 文件还不存在 */
  }
}

function log(level, scope, message, extra) {
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase()}] [${scope}] ${message}${
    extra ? ' | ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''
  }`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  if (logFile) {
    rotate();
    try {
      fs.appendFileSync(logFile, line + '\n', 'utf8');
    } catch {
      /* 忽略写盘失败 */
    }
  }
  if (sink) {
    try {
      sink({ level, scope, message, time: ts });
    } catch {
      /* 窗口可能已关闭 */
    }
  }
}

module.exports = {
  init,
  log,
  info: (scope, msg, extra) => log('info', scope, msg, extra),
  warn: (scope, msg, extra) => log('warn', scope, msg, extra),
  error: (scope, msg, extra) =>
    log('error', scope, msg, extra instanceof Error ? extra.message : extra),
  getLogFile: () => logFile,
  logFile,
};
