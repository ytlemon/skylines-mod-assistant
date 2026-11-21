/* ============================================================
   应用主逻辑：路由 / 数据流 / 交互
   ============================================================ */
(function () {
  'use strict';

  const NM = window.NM;
  const api = NM.api;
  const R = NM.render;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const VIEW_TITLE = {
    discover: '发现',
    installed: '已安装',
    downloads: '下载队列',
    settings: '源与设置',
  };

  const state = {
    view: 'discover',
    settings: {},
    game: { valid: false },
    sources: [],
    catalog: [],
    sourceErrors: {},
    installed: { items: [], counts: { enabled: 0, disabled: 0, manual: 0 }, totalSize: 0 },
    tasks: [],
    filter: { q: '', type: 'all', sort: 'updated' },
    selectedId: null,
    refreshing: false,
  };

  /* ------------------------------ 小工具 ------------------------------ */
  function toast(message, type, detail, ms) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast toast--${type || 'info'}`;
    el.innerHTML = `<span class="toast-bar"></span><span class="toast-msg">${R.esc(message)}${
      detail ? `<small>${R.esc(detail)}</small>` : ''
    }</span>`;
    box.appendChild(el);
    const life = ms || (type === 'err' ? 6000 : 3200);
    setTimeout(() => {
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 240);
    }, life);
    while (box.children.length > 4) box.firstElementChild.remove();
  }

  function pushLog(level, scope, message) {
    const body = $('#logBody');
    const line = document.createElement('div');
    line.className = `log-line${level === 'error' ? ' is-error' : level === 'warn' ? ' is-warn' : ''}`;
    const t = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    line.innerHTML = `<b>${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}</b> [${
      R.esc(scope || 'ui')
    }] ${R.esc(message)}`;
    body.appendChild(line);
    while (body.children.length > 240) body.firstElementChild.remove();
    body.scrollTop = body.scrollHeight;
    $('#statusLog').textContent = message;
  }

  async function safe(fn, label) {
    try {
      return await fn();
    } catch (e) {
      const msg = (e && e.message) || String(e);
      toast(label ? `${label}失败` : '操作失败', 'err', msg);
      pushLog('error', 'ui', `${label || '操作'}失败：${msg}`);
      return null;
    }
  }

  const installedMap = () => {
    const map = {};
    for (const item of state.installed.items || []) map[item.id] = item;
    return map;
  };

  /* ------------------------------ 路由 ------------------------------ */
  function setView(name) {
    if (!VIEW_TITLE[name]) return;
    state.view = name;
    $$('.nav-item').forEach((n) => n.classList.toggle('is-active', n.dataset.view === name));
    $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${name}`));
    $('#viewTitle').textContent = VIEW_TITLE[name];
    if (name === 'installed') loadInstalled();
    if (name === 'downloads') renderQueue();
    if (name === 'settings') renderSources();
  }

  /* ------------------------------ 数据加载 ------------------------------ */
  async function boot() {
    const info = await safe(() => api.appInfo(), '初始化');
    if (!info) return;

    state.settings = info.settings || {};
    state.game = info.game || { valid: false };
    state.sources = (info.settings && info.settings.sources) || [];

    $('#statusVersion').textContent = 'v' + (info.version || '1.0.0');
    if ($('#concurrencyRange')) applySettingsToForm();
    renderGameState();
    renderSources();
    pushLog('info', 'boot', `应用已启动 ${NM.isDemo ? '（演示数据）' : ''}`);

    await Promise.all([refreshCatalog(true), loadInstalled(), loadTasks()]);
    startBackground();
    bindGlobal();

    if (info.initialView === 'settings') {
      setView('settings');
      requestAnimationFrame(() => {
        const panel = document.querySelector('.panel--creds');
        if (panel) panel.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
  }

  function renderGameState() {
    const valid = !!state.game.valid;
    const path = state.game.addonsPath || '';
    $('#sideGamePath').textContent = valid ? path : '未检测到游戏目录';
    $('#sideGamePath').title = path;
    const box = $('#gamePathBox');
    if (box) {
      box.textContent = valid ? path : state.game.reason || '未配置，请在设置中指定';
      box.classList.toggle('is-bad', !valid);
    }
    $('#statusGame').textContent = valid ? `游戏目录：${path}` : '游戏目录：未检测';

    const dot = $('#statusDot');
    dot.className = 'dot ' + (valid ? 'is-online' : 'is-error');
    $('#netDot').className = 'dot ' + (valid ? 'is-online' : 'is-error');
  }

  async function refreshCatalog(force) {
    if (state.refreshing) return;
    state.refreshing = true;
    $('#refreshBtn').disabled = true;
    if (!state.catalog.length) $('#modGrid').innerHTML = R.skeleton(6);
    $('#statMeta').textContent = '正在同步源…';

    const res = await safe(() => api.catalog.refresh({ force: !!force }), '同步 Mod 源');
    state.refreshing = false;
    $('#refreshBtn').disabled = false;

    if (!res) {
      $('#statMeta').textContent = '同步失败';
      return;
    }

    state.catalog = res.entries || [];
    state.sourceErrors = {};
    for (const err of res.errors || []) state.sourceErrors[err.sourceId] = err.message;

    renderDiscover();
    renderSources();
    updateStats(res);

    const errCount = (res.errors || []).length;
    if (errCount) {
      toast(`${errCount} 个源同步失败`, 'warn', res.errors.map((e) => `${e.label}：${e.message}`).join('\n'), 7000);
    }
    pushLog(
      'info',
      'catalog',
      `已同步 ${state.catalog.length} 个 Mod / ${(res.sources || []).length} 个源${errCount ? ` / ${errCount} 个失败` : ''}`
    );
  }

  function updateStats(res) {
    $('#statTotal').textContent = state.catalog.length;
    $('#statSources').textContent = (state.sources || []).filter((s) => s.enabled).length;
    $('#statInstalled').textContent = (state.installed.items || []).filter((i) => i.enabled).length;
    $('#navDiscoverCount').textContent = state.catalog.length;
    $('#navInstalledCount').textContent = (state.installed.items || []).length;
    const ts = (res && res.ts) || Date.now();
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    $('#statMeta').textContent = `上次同步 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

    const online = (state.sources || []).length > 0;
    $('#netDot').className = 'dot ' + (online ? 'is-online' : 'is-error');
    $('#netText').textContent = online ? `${state.sources.length} 个源在线` : '未连接源';
  }

  async function loadInstalled() {
    const res = await safe(() => api.local.list(), '读取已安装列表');
    if (!res) return;
    state.installed = res;
    renderInstalled();
    updateStats();
    if (!res.valid) {
      $('#installedSub').textContent = res.reason || '游戏目录不可用';
    } else {
      const c = res.counts || {};
      $('#installedSub').textContent = `${c.enabled || 0} 个启用 · ${c.disabled || 0} 个禁用 · 占用 ${R.fmtSize(
        res.totalSize
      )}`;
    }
  }

  async function loadTasks() {
    const list = await safe(() => api.download.list(), '读取下载队列');
    if (!list) return;
    state.tasks = mergeTasks(state.tasks, list);
    renderQueue();
  }

  function mergeTasks(prev, incoming) {
    const map = new Map(prev.map((t) => [t.taskId, t]));
    for (const t of incoming) map.set(t.taskId, t);
    return [...map.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }

  /* ------------------------------ 发现页 ------------------------------ */
  function filteredCatalog() {
    const { q, type, sort } = state.filter;
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let list = state.catalog.filter((e) => {
      if (type !== 'all' && e.type !== type) return false;
      if (!words.length) return true;
      const hay = `${e.name} ${e.author || ''} ${(e.tags || []).join(' ')} ${e.description || ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    list = list.slice();
    if (sort === 'name') list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
    else if (sort === 'size') list.sort((a, b) => (b.size || 0) - (a.size || 0));
    else if (sort === 'version') list.sort((a, b) => String(b.version).localeCompare(String(a.version)));
    else list.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
    return list;
  }

  function renderDiscover() {
    const grid = $('#modGrid');
    const list = filteredCatalog();
    const map = installedMap();

    $('#discoverEmpty').hidden = state.catalog.length > 0;
    if (!state.catalog.length) {
      grid.innerHTML = '';
      return;
    }

    // 分批增量渲染，避免源很多时一次性插入造成卡顿
    if (list.length <= 24) {
      grid.innerHTML = list.map((e) => R.card(e, map)).join('');
      return;
    }

    grid.innerHTML = list.slice(0, 24).map((e) => R.card(e, map)).join('');
    let i = 24;
    const step = () => {
      if (i >= list.length) return;
      const frag = document.createElement('div');
      frag.innerHTML = list.slice(i, i + 24).map((e) => R.card(e, map)).join('');
      const nodes = Array.from(frag.children);
      for (const n of nodes) grid.appendChild(n);
      i += 24;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ------------------------------ 已安装页 ------------------------------ */
  function renderInstalled() {
    const items = state.installed.items || [];
    const list = $('#installedList');
    $('#installedEmpty').hidden = items.length > 0;
    list.innerHTML = items
      .slice()
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
      .map((i) => R.installedRow(i))
      .join('');
    $('#navInstalledCount').textContent = items.length;
  }

  async function checkUpdates() {
    await refreshCatalog(true);
    await loadInstalled();
    const n = (state.installed.items || []).filter((i) => i.updatable).length;
    if (n) toast(`发现 ${n} 个可更新的 Mod`, 'warn', '点击行内「更新」即可升级');
    else toast('全部已是最新版本', 'ok');
  }

  /* ------------------------------ 队列页 ------------------------------ */
  function renderQueue() {
    const tasks = state.tasks;
    const active = tasks.filter((t) => ['queued', 'downloading', 'verifying', 'installing', 'paused'].includes(t.status));
    $('#navDownloadBadge').textContent = active.length;
    $('#navDownloadBadge').classList.toggle('is-live', active.length > 0);
    $('#queueEmpty').hidden = tasks.length > 0;
    $('#queueSub').textContent = `${tasks.length} 个任务 · ${active.length} 个进行中`;

    $('#queueList').innerHTML = tasks.map((t) => R.queueRow(t)).join('');

    const totalBytes = tasks.reduce((s, t) => s + (t.total || 0), 0);
    const gotBytes = tasks.reduce((s, t) => s + (t.received || 0), 0);
    const pct = totalBytes ? Math.min(100, (gotBytes / totalBytes) * 100) : 0;
    const speed = tasks.reduce((s, t) => s + (t.status === 'downloading' ? t.speed || 0 : 0), 0);
    $('#queueTotalFill').style.width = pct.toFixed(1) + '%';
    $('#queueTotalText').textContent = `总进度 ${pct.toFixed(0)}% · ${R.fmtSize(gotBytes)} / ${R.fmtSize(totalBytes)}`;
    $('#queueSpeedText').textContent = R.fmtSpeed(speed);
    $('#pauseAllBtn').textContent = active.some((t) => t.status === 'downloading') ? '全部暂停' : '全部继续';
  }

  /* ------------------------------ 源与设置 ------------------------------ */
  function renderSources() {
    const list = $('#sourceList');
    if (!list) return; // 设置页目前是占位页
    const sources = state.sources || [];
    $('#sourceCount').textContent = `${sources.length} 个`;
    list.innerHTML = sources.length
      ? sources.map((s) => R.sourceCard(s, state.sourceErrors[s.id])).join('')
      : R.sourceEmpty;
  }

  function applySettingsToForm() {
    const s = state.settings || {};
    $('#concurrencyRange').value = s.concurrency || 3;
    $('#concurrencyVal').textContent = s.concurrency || 3;
    $('#mirrorInput').value = s.mirror || '';
    if (s.theme === 'magenta') document.body.classList.add('theme-magenta');
    renderCredentialState();
  }

  /* ------------------------------ 账号密钥 ------------------------------ */
  function renderCredentialState() {
    const creds = (state.settings && state.settings.credentials) || {};
    const setState = (platform, info, elId) => {
      const el = $('#' + elId);
      if (!el) return;
      const saved = !!(info && info.saved);
      el.textContent = saved ? `已保存 ${info.hint || ''}` : '未保存';
      el.classList.toggle('is-saved', saved);
      const card = $(`.cred-card[data-platform="${platform}"]`);
      if (card) card.classList.toggle('has-cred', saved);
    };
    setState('github', creds.github, 'credStateGithub');
    setState('gitee', creds.gitee, 'credStateGitee');
    const hint = $('#credEncryptedHint');
    if (hint) {
      hint.textContent = creds.encrypted
        ? '已用系统 DPAPI 加密存储'
        : '仅保存在本机配置文件';
    }
  }

  async function handleCredential(action, platform) {
    const input = $(`#credInput${platform === 'gitee' ? 'Gitee' : 'Github'}`);
    const userInput = $(`#credUser${platform === 'gitee' ? 'Gitee' : 'Github'}`);
    const label = platform === 'gitee' ? 'Gitee' : 'GitHub';

    if (action === 'save') {
      const token = (input.value || '').trim();
      if (!token) return toast('请先粘贴密钥', 'warn');
      const next = await safe(() => api.auth.save(platform, token), '保存密钥');
      if (!next) return;
      state.settings.credentials = next;
      input.value = '';
      renderCredentialState();
      pushLog('info', 'auth', `已保存 ${label} 密钥`);
      return toast(`${label} 密钥已保存`, 'ok');
    }

    if (action === 'clear') {
      if (!window.confirm(`清除已保存的 ${label} 密钥？`)) return;
      const next = await safe(() => api.auth.clear(platform), '清除密钥');
      if (!next) return;
      state.settings.credentials = next;
      renderCredentialState();
      return toast(`${label} 密钥已清除`, 'ok');
    }

    if (action === 'test') {
      const res = await safe(() => api.auth.test(platform), '验证密钥');
      if (!res) return;
      return toast(`${label} 密钥有效`, 'ok', res.login ? `账号：${res.login}` : '');
    }

    if (action === 'gitRead') {
      const res = await safe(() => api.auth.gitRead(platform), '读取 Git 凭据');
      if (!res) return;
      if (input && res.password) input.value = res.password;
      if (userInput && res.username) userInput.value = res.username;
      return toast(`已从 Git 凭据管理器读到 ${label} 账号`, 'ok', res.username || '');
    }

    if (action === 'gitWrite') {
      const token = (input.value || '').trim();
      if (!token) return toast('先把密钥粘贴到输入框，再写入 Git', 'warn');
      const username = ((userInput && userInput.value) || '').trim();
      if (!username) return toast('请填写用户名', 'warn');
      const res = await safe(() => api.auth.gitWrite(platform, username, token), '写入 Git 凭据');
      if (!res) return;
      return toast('已写入本机 Git 凭据管理器', 'ok', `${res.host} · ${username}`);
    }
  }

  /* ------------------------------ 详情抽屉 ------------------------------ */
  async function openDrawer(id) {
    state.selectedId = id;
    const detail = await safe(() => api.catalog.detail(id), '读取详情');
    if (!detail || !detail.entry) return;
    const entry = detail.entry;

    $('#drawerKicker').textContent = `${R.typeEn(entry.type)} · v${entry.version}`;
    $('#drawerName').textContent = entry.name;
    $('#drawerMeta').innerHTML = [
      `<span>作者 <b>${R.esc(entry.author || '未知')}</b></span>`,
      `<span>来源 <b>${R.esc(entry.sourceLabel || '')}</b></span>`,
      `<span>更新 <b>${R.esc(R.fmtDate(entry.updated))}</b></span>`,
    ].join('');

    $('#drawerTags').innerHTML = (entry.tags || [])
      .map((t, i) => `<span class="tag${i % 2 ? ' tag--violet' : ''}">${R.esc(t)}</span>`)
      .join('');
    $('#drawerDesc').textContent = entry.description || '暂无简介';

    const deps = (detail.deps && detail.deps.required) || [];
    const missing = (detail.deps && detail.deps.missing) || [];
    $('#drawerDepsSection').hidden = !deps.length && !missing.length;
    $('#drawerDeps').innerHTML = [
      ...deps.map(
        (d) => `<div class="dep-item"><span class="dot"></span><span>${R.esc(d.name)}</span>
        <span class="muted" style="margin-left:auto">v${R.esc(d.version)}</span></div>`
      ),
      ...missing.map(
        (d) => `<div class="dep-item is-missing"><span class="dot"></span><span>${R.esc(
          d.name
        )}</span><span class="muted" style="margin-left:auto">源中未收录</span></div>`
      ),
    ].join('');

    $('#drawerChangeSection').hidden = !entry.changelog;
    $('#drawerChangelog').textContent = entry.changelog || '';

    $('#drawerFacts').innerHTML = `
      <div class="fact"><dt>安装位置</dt><dd>Addons\\${R.esc(entry.installTo || 'Mods')}</dd></div>
      <div class="fact"><dt>体积</dt><dd>${R.fmtSize(entry.size)}</dd></div>
      <div class="fact"><dt>类型</dt><dd>${R.esc(R.typeLabel(entry.type))}</dd></div>
      <div class="fact"><dt>校验</dt><dd>${entry.sha256 ? 'sha256 已提供' : '未提供'}</dd></div>
    `;

    const installed = detail.installed;
    const btn = $('#drawerDownload');
    if (installed && installed.version === entry.version) {
      btn.textContent = '已安装最新版本';
      btn.disabled = true;
    } else if (installed) {
      btn.textContent = `更新到 v${entry.version}`;
      btn.disabled = false;
    } else {
      btn.textContent = '下载并安装';
      btn.disabled = false;
    }

    $('#drawerHomepage').hidden = !entry.homepage;
    $('#drawerHomepage').dataset.url = entry.homepage || '';

    const drawer = $('#drawer');
    drawer.setAttribute('aria-hidden', 'false');
  }

  function closeDrawer() {
    $('#drawer').setAttribute('aria-hidden', 'true');
    state.selectedId = null;
  }

  /* ------------------------------ 下载动作 ------------------------------ */
  async function startDownload(id) {
    const res = await safe(() => api.download.start(id), '开始下载');
    if (!res) return;
    const entry = state.catalog.find((e) => e.id === id);
    toast(`已加入下载队列：${entry ? entry.name : id}`, 'ok');
    if (res.deps && res.deps.missing && res.deps.missing.length) {
      toast('部分依赖未在源中找到', 'warn', res.deps.missing.map((d) => d.id).join('、'), 6000);
    }
    if (res.deps && res.deps.required && res.deps.required.length) {
      toast(`同时补齐 ${res.deps.required.length} 个依赖`, 'info');
    }
    await loadTasks();
    setView('downloads');
  }

  /* ------------------------------ 事件绑定 ------------------------------ */
  function bindGlobal() {
    // 导航
    document.addEventListener('click', async (ev) => {
      const nav = ev.target.closest('.nav-item');
      if (nav) return setView(nav.dataset.view);

      const goto = ev.target.closest('[data-goto]');
      if (goto) return setView(goto.dataset.goto);

      const chip = ev.target.closest('.chip');
      if (chip) {
        $$('.chip').forEach((c) => c.classList.remove('is-active'));
        chip.classList.add('is-active');
        state.filter.type = chip.dataset.type;
        return renderDiscover();
      }

      const card = ev.target.closest('.card');
      if (card) {
        const dl = ev.target.closest('[data-act="download"]');
        if (dl) {
          ev.stopPropagation();
          return startDownload(dl.dataset.id);
        }
        return openDrawer(card.dataset.id);
      }

      const act = ev.target.closest('[data-act]');
      if (act) {
        const { act: action, id, task, source } = act.dataset;
        if (action === 'pause') {
          await api.download.pause(task);
          return loadTasks();
        }
        if (action === 'resume') {
          await api.download.resume(task);
          return loadTasks();
        }
        if (action === 'cancel') {
          await api.download.cancel(task);
          return loadTasks();
        }
        if (action === 'toggle') return toggleLocal(id);
        if (action === 'uninstall') return uninstallLocal(id);
        if (action === 'update') return updateLocal(id);
        if (action === 'open') return api.local.open(id);
        if (action === 'refreshSource') return refreshSource(source);
        if (action === 'removeSource') return removeSource(source);
        if (action === 'rollback') return rollbackLocal(id);
      }

      if (ev.target.closest('#drawerScrim') || ev.target.closest('#drawerClose')) return closeDrawer();
    });

    // 搜索
    let timer = null;
    $('#searchInput').addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.filter.q = e.target.value;
        renderDiscover();
      }, 160);
    });

    $('#sortSelect').addEventListener('change', (e) => {
      state.filter.sort = e.target.value;
      renderDiscover();
    });

    $('#refreshBtn').addEventListener('click', () => refreshCatalog(true));
    $('#checkUpdatesBtn').addEventListener('click', checkUpdates);
    $('#openModsDir').addEventListener('click', () => api.game.open('mods'));

    $('#pauseAllBtn').addEventListener('click', async () => {
      const active = state.tasks.some((t) => t.status === 'downloading');
      if (active) await api.download.pauseAll();
      else await api.download.resumeAll();
      await loadTasks();
    });
    $('#clearDoneBtn').addEventListener('click', async () => {
      await api.download.clear();
      state.tasks = state.tasks.filter((t) => !['done', 'error', 'canceled'].includes(t.status));
      renderQueue();
    });

    // 设置页当前是「敬请期待」占位，下面这些控件不存在，整块绑定做存在性判断，
    // 避免 addEventListener 抛错导致后续绑定（窗口控制 / 键盘 / 主进程事件）全部失效。
    if ($('#sourceForm')) {
    // 源添加
    let platform = 'github';
    let mode = 'manifest';
    $$('#platformSeg .seg-btn').forEach((b) =>
      b.addEventListener('click', () => {
        platform = b.dataset.platform;
        $$('#platformSeg .seg-btn').forEach((x) => x.classList.toggle('is-active', x === b));
      })
    );
    $$('#modeSeg .seg-btn').forEach((b) =>
      b.addEventListener('click', () => {
        mode = b.dataset.mode;
        $$('#modeSeg .seg-btn').forEach((x) => x.classList.toggle('is-active', x === b));
      })
    );

    $('#sourceForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const owner = $('#sourceOwner').value.trim();
      const repo = $('#sourceRepo').value.trim();
      const branch = $('#sourceBranch').value.trim() || 'main';
      if (!owner || !repo) return toast('请填写 owner 与 repo', 'warn');
      const list = await safe(() => api.sources.add({ platform, owner, repo, branch, mode }), '添加源');
      if (!list) return;
      state.sources = list;
      $('#sourceOwner').value = '';
      $('#sourceRepo').value = '';
      renderSources();
      updateStats();
      toast('源已添加，开始同步…', 'ok');
      await refreshCatalog(true);
    });

    // 设置
    $('#concurrencyRange').addEventListener('input', (e) => {
      $('#concurrencyVal').textContent = e.target.value;
    });
    $('#saveSettingsBtn').addEventListener('click', async () => {
      const patch = {
        concurrency: Number($('#concurrencyRange').value) || 3,
        mirror: $('#mirrorInput').value.trim(),
      };
      const next = await safe(() => api.settings.save(patch), '保存设置');
      if (!next) return;
      state.settings = next;
      toast('设置已保存', 'ok');
    });

    // 账号密钥：保存 / 验证 / 清除 / 读写 Git 凭据
    $$('[data-cred]').forEach((btn) =>
      btn.addEventListener('click', () =>
        handleCredential(btn.dataset.cred, btn.dataset.platform || 'github')
      )
    );

    $('#autoDetectBtn').addEventListener('click', async () => {
      const d = await safe(() => api.game.detect(), '探测游戏目录');
      if (!d) return;
      if (d.path) {
        await api.settings.save({ addonsPath: d.path });
        state.game.valid = true;
        state.game.addonsPath = d.path;
        renderGameState();
        toast('已探测到天际线数据目录', 'ok', d.path);
      } else {
        toast('未探测到目录，请手动选择', 'warn', (d.candidates || []).join('\n'));
      }
    });

    $('#chooseDirBtn').addEventListener('click', async () => {
      const r = await safe(() => api.game.choose(), '选择目录');
      if (!r || r.canceled) return;
      if (!r.ok) return toast('该目录无效', 'err', r.reason);
      state.game.valid = true;
      state.game.addonsPath = r.path;
      renderGameState();
      await loadInstalled();
      toast('游戏目录已更新', 'ok', r.path);
    });

    $('#cleanCacheBtn').addEventListener('click', async () => {
      const r = await safe(() => api.cache.clean(), '清理缓存');
      if (r) toast('缓存已清理', 'ok', `释放 ${R.fmtSize(r.freed)}`);
    });

    $('#openLogBtn').addEventListener('click', () => $('#logPanel').classList.toggle('is-open'));
    } // end of 设置页控件绑定

    $('#logToggle').addEventListener('click', () => $('#logPanel').classList.toggle('is-open'));
    $('#logClose').addEventListener('click', () => $('#logPanel').classList.remove('is-open'));

    // 抽屉按钮
    $('#drawerDownload').addEventListener('click', async () => {
      const id = state.selectedId;
      if (!id) return;
      closeDrawer();
      await startDownload(id);
    });
    $('#drawerHomepage').addEventListener('click', (e) => {
      const url = e.currentTarget.dataset.url;
      if (url) api.shell.openExternal(url);
    });

    // 窗口控制
    $('#winMin').addEventListener('click', () => api.win.control('min'));
    $('#winMax').addEventListener('click', () => api.win.control('max'));
    $('#winClose').addEventListener('click', () => api.win.control('close'));

    // 键盘
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setView('discover');
        $('#searchInput').focus();
      }
      if (e.key === 'Escape') {
        closeDrawer();
        $('#logPanel').classList.remove('is-open');
      }
    });

    // 主进程事件
    if (api.on) {
      api.on('evt:task', (task) => {
        const idx = state.tasks.findIndex((t) => t.taskId === task.taskId);
        if (idx >= 0) state.tasks[idx] = task;
        else state.tasks.unshift(task);
        renderQueue();
        if (['installing', 'verifying'].includes(task.status)) $('#statusLog').textContent = `${task.name}：${R.statusText(task.status)}`;
      });

      api.on('evt:installed', async (info) => {
        toast(`已安装 ${info.name} v${info.version}`, 'ok');
        pushLog('info', 'install', `${info.name} v${info.version} 安装完成`);
        await loadInstalled();
        renderDiscover();
      });

      api.on('evt:log', (entry) => pushLog(entry.level, entry.scope, entry.message));
    }
  }

  /* ------------------------------ 本地操作 ------------------------------ */
  async function toggleLocal(id) {
    const item = (state.installed.items || []).find((i) => i.id === id);
    if (!item) return;
    const r = await safe(() => api.local.toggle(id, !item.enabled), item.enabled ? '禁用' : '启用');
    if (!r) return;
    toast(`${item.name} 已${item.enabled ? '禁用' : '启用'}`, 'ok');
    await loadInstalled();
    renderDiscover();
  }

  async function uninstallLocal(id) {
    const item = (state.installed.items || []).find((i) => i.id === id);
    if (!item) return;
    if (!window.confirm(`确定卸载「${item.name}」吗？\n旧文件会自动备份，可随时回滚。`)) return;
    const r = await safe(() => api.local.uninstall(id), '卸载');
    if (!r) return;
    toast(`${item.name} 已卸载`, 'ok', r.backup ? '已创建备份' : '');
    await loadInstalled();
    renderDiscover();
  }

  async function updateLocal(id) {
    const r = await safe(() => api.local.updateOne(id), '更新');
    if (!r) return;
    toast('已加入更新队列', 'ok');
    await loadTasks();
    setView('downloads');
  }

  async function rollbackLocal(id) {
    const r = await safe(() => api.local.rollback(id), '回滚');
    if (!r) return;
    toast('已回滚到上一个备份版本', 'ok');
    await loadInstalled();
  }

  async function refreshSource(id) {
    const src = (state.sources || []).find((s) => s.id === id);
    if (!src) return;
    toast(`正在刷新 ${src.owner}/${src.repo}`, 'info');
    await refreshCatalog(true);
  }

  async function removeSource(id) {
    const src = (state.sources || []).find((s) => s.id === id);
    if (!src) return;
    if (!window.confirm(`删除源 ${src.owner}/${src.repo}？\n只会移除配置，不会删除本地已安装的 Mod。`)) return;
    const list = await safe(() => api.sources.remove(id), '删除源');
    if (!list) return;
    state.sources = list;
    renderSources();
    updateStats();
    await refreshCatalog(true);
    toast('源已删除', 'ok');
  }

  /* ------------------------------ 背景粒子 ------------------------------ */
  function startBackground() {
    const canvas = $('#bgCanvas');
    if (!canvas) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const ctx = canvas.getContext('2d');
    let w = 0;
    let h = 0;
    let dpr = 1;
    const dots = [];

    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const seed = () => {
      const count = Math.min(64, Math.round((w * h) / 26000));
      dots.length = 0;
      for (let i = 0; i < count; i++) {
        dots.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.22,
          vy: (Math.random() - 0.5) * 0.22,
          r: Math.random() * 1.5 + 0.5,
          magenta: Math.random() > 0.78,
        });
      }
    };

    resize();
    seed();
    window.addEventListener('resize', () => {
      resize();
      seed();
    });

    const tick = () => {
      ctx.clearRect(0, 0, w, h);

      for (const d of dots) {
        d.x += d.vx;
        d.y += d.vy;
        if (d.x < -20) d.x = w + 20;
        if (d.x > w + 20) d.x = -20;
        if (d.y < -20) d.y = h + 20;
        if (d.y > h + 20) d.y = -20;

        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = d.magenta ? 'rgba(255,46,151,0.55)' : 'rgba(0,240,255,0.5)';
        ctx.fill();
      }

      // 近邻连线：营造数据网络感
      for (let i = 0; i < dots.length; i++) {
        for (let j = i + 1; j < dots.length; j++) {
          const a = dots[i];
          const b = dots[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist2 = dx * dx + dy * dy;
          if (dist2 > 16000) continue;
          const alpha = (1 - dist2 / 16000) * 0.18;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = `rgba(0,240,255,${alpha.toFixed(3)})`;
          ctx.lineWidth = 0.6;
          ctx.stroke();
        }
      }

      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ------------------------------ 启动 ------------------------------ */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
