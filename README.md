# 天际线 Mod 助手（NeonMod）

一个自建源驱动的《Cities: Skylines》Mod 分发客户端。不依赖 Steam 创意工坊、不需要 SteamCMD —— 你把 Mod 打包发到自己的 **GitHub** 或 **Gitee** 仓库，助手负责聚合、搜索、下载、自动安装到游戏目录，并管理版本与依赖。

界面为深色霓虹风格，Electron 单窗口应用。

## 快速开始

```bash
npm install
npm start          # 启动
npm run dist       # 打包 Windows 安装包（dist/）
npm run preview    # 仅预览界面（浏览器打开 http://127.0.0.1:5183）
```

## 三个动作就能用起来

1. **建仓库**：在 GitHub / Gitee 建一个公开仓库，根目录放 `mods.json`（模板见 [`docs/mods.json.example`](docs/mods.json.example)）。
2. **发安装包**：把每个 Mod 目录压成 zip，上传到仓库的 Releases，把直链填进 `mods.json` 的 `downloadUrl`。
3. **加源**：在应用「源与设置」里填 `owner` / `repo`，读取方式选「读取 mods.json」。刷新后即可在「发现」页看到所有 Mod。

> 也可以不用清单：选「解析 Releases」，助手会把每个 release 里的 `.zip` 资产当作一个可下载包，tag 作为版本号。

## mods.json 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 全局唯一，建议用英文短横线命名 |
| `name` | 是 | 显示名称（中文可用） |
| `version` | 是 | 版本号，支持 semver，用于更新比较 |
| `downloadUrl` | 是 | zip 直链，支持相对仓库 raw 根的相对路径 |
| `type` | 否 | `mod` / `asset` / `map` / `tool`，默认按 `installTo` 推断 |
| `installTo` | 否 | `Mods` / `Assets` / `Maps`，默认 `Mods` |
| `dirName` | 否 | 安装后的目录名，默认取 `name` |
| `deps` | 否 | 依赖的 `id` 数组，下载时会自动补齐 |
| `sha256` | 否 | 提供后下载完会强制校验 |
| `size` | 否 | 字节数，仅用于展示与进度预估 |
| `tags` / `description` / `author` / `homepage` / `changelog` / `updated` | 否 | 展示用 |

## 安装位置与安全

- 安装目录：`%LOCALAPPDATA%\Colossal Order\Cities_Skylines\Addons\{Mods|Assets|Maps}\<目录名>`
- 启用 / 禁用通过在 `Addons` 与 `userData/disabled` 之间移动目录实现，**不删除文件**
- 覆盖安装前自动整目录备份到 `userData/backups/<id>/`，保留最近 5 份，可一键回滚
- 解压前逐条校验 zip 条目，拒绝绝对路径与 `..` 越界；所有写操作限制在 `Addons` 与 `userData` 内
- 渲染进程开启 `contextIsolation`、关闭 `nodeIntegration`，只通过 preload 白名单调用主进程

## 密钥保存

Gitee / GitHub 的令牌**不要写进代码或清单**。两种保存方式：

1. **应用内**：「源与设置 → 账号密钥」，粘贴后保存。落盘走 Electron `safeStorage`（Windows DPAPI）加密，`settings.json` 里只有密文，渲染层只显示掩码。
2. **本机 Git 凭据管理器**：双击 `tools/save-gitee-key.cmd`，在弹出窗口里输入用户名与令牌（输入不显示）。令牌经 `git credential approve` 存入 Windows 凭据管理器，之后 `git push` 到 gitee 自动认证。

两者可互通：应用里的「从 Git 读取」按钮会把凭据管理器里的令牌读进输入框；「写入 Git」则反向存进去。脚本不会打印、记录或落盘明文密钥。

保存后想确认是否可用，运行 `tools/check-gitee-cred.ps1`（只输出账号名、令牌长度与掩码，不打印令牌）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/check-gitee-cred.ps1
```

输出 `RESULT=OK LOGIN=ytlemon` 即表示凭据库里的令牌有效。

## 目录结构

```
main/                 主进程（网络、文件、解压、队列）
  services/
    repos.js          源抓取（mods.json 清单 / Releases 两种通道）
    catalog.js        多源聚合、去重、缓存、搜索、依赖解析
    downloader.js     并发队列、Range 断点续传、重试、镜像前缀
    installer.js      解压安装、zip 安全校验、备份回滚、启禁用
    local.js          本地扫描与版本比对
renderer/             渲染层（原生 HTML/CSS/JS，无框架）
  css/tokens.css      霓虹配色与设计令牌
docs/mods.json.example
tools/preview-server.js
```

## 设置项

- **游戏数据目录**：启动时自动探测 `%LOCALAPPDATA%\Colossal Order\Cities_Skylines`，也可手动指定
- **GitHub 加速前缀**：如 `https://ghfast.top/`，只对 github 域名生效；Gitee 走直连
- **并发数**：默认 3，上限 6
- **Token**：可选，GitHub PAT 或 Gitee 私人令牌，用于提升 API 限流额度

## 常见问题

**加了源但列表是空的？**
仓库根目录没有 `mods.json`，或清单里 `downloadUrl` 为空。选「解析 Releases」可绕开清单。

**提示接口限流？**
GitHub 匿名 API 每小时 60 次。在设置里填 Token 即可。

**下载很慢 / 失败？**
填一个 GitHub 加速前缀；Gitee 源本身在国内通常直连可用。

**游戏里看不到 Mod？**
确认安装位置是 `Addons\Mods`，且目录里有 `.dll`；本地 Mod 需要在游戏的「内容管理器」里手动勾选。
