'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

const UA = 'NeonModAssistant/1.0 (Cities:Skylines mod helper)';

/**
 * 发起请求（手动跟随重定向，保留 Range 等头部）。
 * @returns {Promise<import('http').IncomingMessage>}
 */
function request(url, opts = {}) {
  const { method = 'GET', headers = {}, timeout = 30000, redirects = 5, body = null } = opts;

  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error(`无效的链接：${url}`));
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(new Error(`不支持的协议：${u.protocol}`));
    }

    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      u,
      {
        method,
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          ...headers,
        },
        timeout,
      },
      (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new Error('重定向次数过多'));
          let next;
          try {
            next = new URL(res.headers.location, u).toString();
          } catch {
            return reject(new Error('重定向地址无效'));
          }
          return resolve(
            request(next, { method, headers, timeout, redirects: redirects - 1, body })
          );
        }
        resolve(res);
      }
    );

    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function readBody(res, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        res.destroy();
        return reject(new Error('响应内容过大，已中断'));
      }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

async function getText(url, opts = {}) {
  const res = await request(url, opts);
  const code = res.statusCode || 0;
  if (code >= 400) {
    res.resume();
    const err = new Error(`HTTP ${code}：${url}`);
    err.statusCode = code;
    throw err;
  }
  const buf = await readBody(res);
  return buf.toString('utf8');
}

async function getJson(url, opts = {}) {
  const text = await getText(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回内容不是合法 JSON：${url}`);
  }
}

module.exports = { request, getText, getJson, UA };
