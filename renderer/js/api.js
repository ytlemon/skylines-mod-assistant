/* ============================================================
   API 适配层
   - 在 Electron 里直接使用 preload 暴露的 window.api
   - 直接用浏览器打开时退回内置演示数据（便于视觉验收）
   ============================================================ */
(function () {
  'use strict';

  const NM = (window.NM = window.NM || {});

  const DEMO_SOURCES = [
    {
      id: 'github:ytlemon/neon-mods',
      platform: 'github',
      owner: 'ytlemon',
      repo: 'neon-mods',
      branch: 'main',
      mode: 'manifest',
      enabled: true,
    },
    {
      id: 'gitee:ytlemon/skylines-mods',
      platform: 'gitee',
      owner: 'ytlemon',
      repo: 'skylines-mods',
      branch: 'master',
      mode: 'releases',
      enabled: true,
    },
  ];

  const DEMO_CATALOG = [
    {
      id: 'neon-tools',
      name: '霓虹工具箱',
      version: '1.4.2',
      type: 'tool',
      author: 'ytlemon',
      tags: ['工具', 'UI', '汉化'],
      description: '一站式城市面板增强：实时财政曲线、交通热力图、分区密度叠加，全部集成在右侧信息栏。',
      installTo: 'Mods',
      downloadUrl: 'https://github.com/ytlemon/neon-mods/releases/download/v1.4.2/NeonTools.zip',
      size: 1843200,
      deps: ['harmony-core'],
      homepage: 'https://github.com/ytlemon/neon-mods',
      updated: '2026-11-18',
      changelog: '1.4.2\n· 修复读档后热力图不刷新的问题\n· 新增财政曲线导出 CSV\n\n1.4.0\n· 面板改为可折叠卡片',
      sourceLabel: 'GitHub · ytlemon/neon-mods',
      platform: 'github',
      origin: 'manifest',
    },
    {
      id: 'traffic-manager',
      name: '交通调度中枢',
      version: '2.1.0',
      type: 'mod',
      author: 'ytlemon',
      tags: ['交通', 'AI'],
      description: '重写车辆寻路优先级：公交优先、货车错峰、路口动态信号灯，长距离拥堵显著下降。',
      installTo: 'Mods',
      downloadUrl: 'https://github.com/ytlemon/neon-mods/releases/download/v2.1.0/TrafficManager.zip',
      size: 2621440,
      deps: ['harmony-core'],
      homepage: 'https://github.com/ytlemon/neon-mods',
      updated: '2026-11-15',
      changelog: '2.1.0\n· 新增错峰发车开关\n· 修复公交线路重算卡死',
      sourceLabel: 'GitHub · ytlemon/neon-mods',
      platform: 'github',
      origin: 'manifest',
    },
    {
      id: 'neon-district-assets',
      name: '霓虹街区建筑包',
      version: '3.0.1',
      type: 'asset',
      author: 'ytlemon',
      tags: ['建筑', '夜景', '高密度'],
      description: '42 栋带自发光招牌的高密度商业建筑，夜间效果自动联动光照与雨雾反射。',
      installTo: 'Assets',
      downloadUrl: 'https://gitee.com/ytlemon/skylines-mods/releases/download/v3.0.1/neon-district-assets.zip',
      size: 58720256,
      deps: [],
      homepage: 'https://gitee.com/ytlemon/skylines-mods',
      updated: '2026-11-12',
      changelog: '3.0.1\n· 修复 LOD 闪面\n· 补齐 6 栋转角楼',
      sourceLabel: 'Gitee · ytlemon/skylines-mods',
      platform: 'gitee',
      origin: 'release',
    },
    {
      id: 'harbor-hills',
      name: '海港丘陵 · 81 格',
      version: '1.0.0',
      type: 'map',
      author: 'ytlemon',
      tags: ['地图', '81格', '海岸'],
      description: '丘陵与深水港结合的 81 格地图，预留铁路干线走廊，适合极限规模城市。',
      installTo: 'Maps',
      downloadUrl: 'https://gitee.com/ytlemon/skylines-mods/releases/download/v1.0.0/harbor-hills.zip',
      size: 12582912,
      deps: [],
      homepage: 'https://gitee.com/ytlemon/skylines-mods',
      updated: '2026-11-08',
      changelog: '首个版本',
      sourceLabel: 'Gitee · ytlemon/skylines-mods',
      platform: 'gitee',
      origin: 'release',
    },
    {
      id: 'harmony-core',
      name: 'Harmony 核心库',
      version: '2.3.5',
      type: 'mod',
      author: 'community',
      tags: ['依赖', '基础'],
      description: '多数运行时补丁 Mod 的前置依赖，安装其他 Mod 前请确保已装本库。',
      installTo: 'Mods',
      downloadUrl: 'https://github.com/ytlemon/neon-mods/releases/download/v2.3.5/HarmonyCore.zip',
      size: 614400,
      deps: [],
      homepage: 'https://github.com/ytlemon/neon-mods',
      updated: '2026-10-30',
      changelog: '2.3.5\n· 兼容最新游戏版本',
      sourceLabel: 'GitHub · ytlemon/neon-mods',
      platform: 'github',
      origin: 'manifest',
    },
    {
      id: 'light-budget',
      name: '光照预算优化',
      version: '0.9.4',
      type: 'mod',
      author: 'ytlemon',
      tags: ['性能', '画质'],
      description: '合并夜间动态光源批次，8 万人口以上实测帧率提升 18%，不改变观感。',
      installTo: 'Mods',
      downloadUrl: 'https://github.com/ytlemon/neon-mods/releases/download/v0.9.4/LightBudget.zip',
      size: 327680,
      deps: [],
      homepage: 'https://github.com/ytlemon/neon-mods',
      updated: '2026-11-03',
      changelog: '0.9.4\n· 修复雨天光晕溢出',
      sourceLabel: 'GitHub · ytlemon/neon-mods',
      platform: 'github',
      origin: 'manifest',
    },
    {
      id: 'fiscal-dashboard',
      name: '财政仪表盘',
      version: '1.1.0',
      type: 'tool',
      author: 'ytlemon',
      tags: ['数据', 'UI'],
      description: '把税收、支出、补贴拆成可交互折线图，支持按区域下钻与多周目对比。',
      installTo: 'Mods',
      downloadUrl: 'https://github.com/ytlemon/neon-mods/releases/download/v1.1.0/FiscalDashboard.zip',
      size: 921600,
      deps: ['neon-tools'],
      homepage: 'https://github.com/ytlemon/neon-mods',
      updated: '2026-11-16',
      changelog: '1.1.0\n· 新增多周目对比\n· 折线图支持框选缩放',
      sourceLabel: 'GitHub · ytlemon/neon-mods',
      platform: 'github',
      origin: 'manifest',
    },
    {
      id: 'rain-roads',
      name: '湿滑路面质感',
      version: '1.2.3',
      type: 'asset',
      author: 'ytlemon',
      tags: ['材质', '天气'],
      description: '雨天路面反射与积水贴图重制，含 4 套可切换的沥青纹理。',
      installTo: 'Assets',
      downloadUrl: 'https://gitee.com/ytlemon/skylines-mods/releases/download/v1.2.3/rain-roads.zip',
      size: 22020096,
      deps: [],
      homepage: 'https://gitee.com/ytlemon/skylines-mods',
      updated: '2026-11-05',
      changelog: '1.2.3\n· 修复夜间高光过曝',
      sourceLabel: 'Gitee · ytlemon/skylines-mods',
      platform: 'gitee',
      origin: 'release',
    },
    {
      id: 'zone-rebalance',
      name: '分区需求重平衡',
      version: '1.0.6',
      type: 'mod',
      author: 'ytlemon',
      tags: ['数值', 'AI'],
      description: '让住宅、商业、工业需求随就业与货运实时联动，避免单一分区长期空置。',
      installTo: 'Mods',
      downloadUrl: 'https://github.com/ytlemon/neon-mods/releases/download/v1.0.6/ZoneRebalance.zip',
      size: 512000,
      deps: ['harmony-core'],
      homepage: 'https://github.com/ytlemon/neon-mods',
      updated: '2026-10-28',
      changelog: '1.0.6\n· 降低工业需求抖动',
      sourceLabel: 'GitHub · ytlemon/neon-mods',
      platform: 'github',
      origin: 'manifest',
    },
  ];

  const DEMO_LOCAL = {
    valid: true,
    addons: 'C:\\Users\\Administrator\\AppData\\Local\\Colossal Order\\Cities_Skylines',
    items: [
      {
        id: 'neon-tools',
        name: '霓虹工具箱',
        version: '1.4.0',
        type: 'tool',
        author: 'ytlemon',
        installTo: 'Mods',
        dirName: 'NeonTools',
        size: 1802240,
        hasDll: true,
        enabled: true,
        manual: false,
        installedAt: '2026-11-10T12:20:00.000Z',
        latestVersion: '1.4.2',
        updatable: true,
        sourceLabel: 'GitHub · ytlemon/neon-mods',
      },
      {
        id: 'harmony-core',
        name: 'Harmony 核心库',
        version: '2.3.5',
        type: 'mod',
        author: 'community',
        installTo: 'Mods',
        dirName: 'HarmonyCore',
        size: 614400,
        hasDll: true,
        enabled: true,
        manual: false,
        installedAt: '2026-10-30T09:05:00.000Z',
        latestVersion: '2.3.5',
        updatable: false,
      },
      {
        id: 'local:Mods/OldPanelTweak',
        name: 'OldPanelTweak',
        version: '',
        type: 'mod',
        author: '',
        installTo: 'Mods',
        dirName: 'OldPanelTweak',
        size: 204800,
        hasDll: true,
        enabled: false,
        manual: true,
        installedAt: '2026-09-18T03:11:00.000Z',
        latestVersion: '',
        updatable: false,
      },
    ],
    totalSize: 2621440,
    counts: { enabled: 2, disabled: 1, manual: 1 },
  };

  const DEMO_TASKS = [
    {
      taskId: 'demo-t1',
      id: 'neon-district-assets',
      name: '霓虹街区建筑包',
      version: '3.0.1',
      status: 'downloading',
      received: 36406272,
      total: 58720256,
      speed: 1258291,
      percent: 62,
      error: '',
      attempts: 1,
    },
    {
      taskId: 'demo-t2',
      id: 'traffic-manager',
      name: '交通调度中枢',
      version: '2.1.0',
      status: 'done',
      received: 2621440,
      total: 2621440,
      speed: 0,
      percent: 100,
      error: '',
      attempts: 1,
    },
  ];

  const DEMO_SETTINGS = {
    addonsPath: 'C:\\Users\\Administrator\\AppData\\Local\\Colossal Order\\Cities_Skylines',
    mirror: 'https://ghfast.top/',
    concurrency: 3,
    theme: 'cyan',
    sources: DEMO_SOURCES,
    credentials: {
      github: { saved: true, hint: 'ghp_••••7f2a' },
      gitee: { saved: false, hint: '' },
      encrypted: true,
    },
  };

  if (window.api) {
    NM.api = window.api;
    NM.isDemo = false;
    return;
  }

  /* ------------------------------ 演示模式 ------------------------------ */
  NM.isDemo = true;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const clone = (v) => JSON.parse(JSON.stringify(v));

  let demoSettings = clone(DEMO_SETTINGS);
  let demoTasks = clone(DEMO_TASKS);

  NM.api = {
    appInfo: async () => ({
      version: '1.0.0',
      userData: 'C:\\Users\\Administrator\\AppData\\Roaming\\neon-mod-assistant',
      settings: clone(demoSettings),
      game: {
        valid: true,
        addonsPath: demoSettings.addonsPath,
        reason: '',
        detected: demoSettings.addonsPath,
        paths: {
          mods: demoSettings.addonsPath + '\\Addons\\Mods',
          assets: demoSettings.addonsPath + '\\Addons\\Assets',
          maps: demoSettings.addonsPath + '\\Addons\\Maps',
        },
      },
      stats: { total: DEMO_CATALOG.length, sources: DEMO_SOURCES.length, errors: [], ts: Date.now() },
      downloads: clone(demoTasks),
      logFile: '',
    }),
    settings: { save: async (patch) => Object.assign(demoSettings, patch) },
    auth: {
      state: async () => clone(demoSettings.credentials),
      save: async (platform, token) => {
        demoSettings.credentials[platform] = { saved: true, hint: token.slice(0, 4) + '••••' + token.slice(-4) };
        return clone(demoSettings.credentials);
      },
      clear: async (platform) => {
        demoSettings.credentials[platform] = { saved: false, hint: '' };
        return clone(demoSettings.credentials);
      },
      test: async (platform) => ({ ok: true, login: platform === 'gitee' ? 'ytlemon' : 'ytlemon', name: 'ytlemon' }),
      gitRead: async (platform) => ({ ok: true, username: 'ytlemon', password: 'demo-token' }),
      gitWrite: async () => ({ ok: true, host: 'gitee.com' }),
    },
    game: {
      detect: async () => ({ path: demoSettings.addonsPath, detected: true, candidates: [] }),
      validate: async () => ({ ok: true, addons: demoSettings.addonsPath + '\\Addons' }),
      choose: async () => ({ canceled: true }),
      open: async () => demoSettings.addonsPath,
    },
    sources: {
      list: async () => clone(demoSettings.sources),
      add: async (input) => {
        demoSettings.sources.push({
          id: `${input.platform}:${input.owner}/${input.repo}`,
          branch: input.branch || 'main',
          mode: input.mode || 'manifest',
          enabled: true,
          ...input,
        });
        return clone(demoSettings.sources);
      },
      remove: async (id) => {
        demoSettings.sources = demoSettings.sources.filter((s) => s.id !== id);
        return clone(demoSettings.sources);
      },
      update: async (id, patch) => {
        demoSettings.sources = demoSettings.sources.map((s) => (s.id === id ? { ...s, ...patch } : s));
        return clone(demoSettings.sources);
      },
    },
    catalog: {
      refresh: async () => {
        await delay(420);
        return { entries: clone(DEMO_CATALOG), errors: [], ts: Date.now(), fromCache: false, sources: DEMO_SOURCES };
      },
      search: async () => clone(DEMO_CATALOG),
      stats: async () => ({ total: DEMO_CATALOG.length, sources: DEMO_SOURCES.length, errors: [], ts: Date.now() }),
      clear: async () => true,
      detail: async (id) => {
        const entry = DEMO_CATALOG.find((e) => e.id === id);
        return {
          entry: clone(entry),
          deps: { required: [], missing: [], cycle: false },
          installed: clone(DEMO_LOCAL.items.find((i) => i.id === id) || null),
        };
      },
    },
    download: {
      start: async (id) => {
        const entry = DEMO_CATALOG.find((e) => e.id === id);
        const task = {
          taskId: 'demo-' + id,
          id,
          name: entry ? entry.name : id,
          version: entry ? entry.version : '',
          status: 'downloading',
          received: 0,
          total: entry ? entry.size : 1048576,
          speed: 943718,
          percent: 0,
          error: '',
          attempts: 1,
        };
        demoTasks.unshift(task);
        return { ok: true, taskIds: [task.taskId], deps: { required: [], missing: [] } };
      },
      startMany: async (ids) => ({ ok: true, taskIds: ids }),
      list: async () => clone(demoTasks),
      pause: async () => true,
      resume: async () => true,
      cancel: async () => true,
      pauseAll: async () => true,
      resumeAll: async () => true,
      clear: async () => [],
    },
    local: {
      list: async () => clone(DEMO_LOCAL),
      toggle: async () => ({ ok: true }),
      uninstall: async () => ({ ok: true }),
      rollback: async () => ({ ok: true }),
      backups: async () => [],
      open: async () => '',
      updateOne: async () => ({ ok: true }),
    },
    shell: { openExternal: async () => true },
    cache: { clean: async () => ({ ok: true, freed: 0 }) },
    win: { control: async () => false, isMaximized: async () => false },
    on: () => () => {},
  };
})();
