# Changelog

本文件按 [Keep a Changelog](https://keepachangelog.com/) 约定记录，版本号遵循 SemVer。

---

## [0.3.0] - 2026-08-18

### Added
- **Agent 自定义大模型（BYOK）**：所有 Agent（含内置中海言析）支持「自定义大模型」模型来源——用户自选供应商并填写自己的 API Key。
  - 云函数 `zhipu-proxy` 升级为多供应商 OpenAI 兼容代理：智谱 / DeepSeek / OpenAI / 通义千问 / 硅基流动 / Kimi + 任意自定义 baseUrl；用户 Key 优先于服务端 `ZHIPU_API_KEY`，Key 仅用于本次转发、不写日志。
  - 前端 Agent 接入表单新增「模型来源」切换（平台默认 / 自定义大模型），Agent 列表支持编辑（⚙），内置 agent 的覆盖设置持久化到 `zhhs01.agentOverrides` 并经云端 rdb 跨端同步（`agentOverrides` 纳入 `user_state` payload）。
  - 对话发送按选中 Agent 的 provider/apiKey/model/baseUrl 动态组装请求体（模型名兼容字符串与对象两种结构）。
- `docs/DEPLOYMENT.md` 整合为 v2.0 最终版（目录划分 / 三步部署 / CI / 密钥 / CORS 收紧 / 缓存回滚 / 桌面端同步机制）。

### Fixed
- 桌面端 `renderer/index.html` 同步两轮缺失（8-17 智谱直连改造未同步），已用 Web 版覆盖一致。
- 删除冗余 `zhhs01-web/_online_index.html`；`deploy.sh` 增加 renderer 同步检查与部署后冒烟校验。

### Changed
- `zhipu-proxy/scf_bootstrap` 使用绝对 Node 路径（`/var/lang/node18/bin/node`）。
- `zhhs01-agent` CORS 从 `*` 收紧为白名单（Web 托管域名 + `Origin:null` 桌面端）。
- `BUILD_TAG` 由 `deploy.sh` 自动递增（时间戳）。
- 新增 `.github/workflows/deploy.yml`：push main 自动发布静态托管 + 云函数。

---

## [0.2.0] - 2026-08-13

### Added
- 代理端进程级异常兜底：`uncaughtException` / `unhandledRejection` / `server.on('error')` 与 SIGTERM/SIGINT 优雅退出。
- 代理端 SSE 透传安全加固：上游流 `error` 监听、响应头已发后仅 `res.end()`、客户端断开中止上游。
- 代理端高并发保护：并发聊天流上限（`MAX_CONCURRENT_CHATS=200`，超限 429）、上游 60s 超时(504)、请求体 1MB 上限(413)。
- Web / 桌面端全局异常兜底 `installGlobalErrorGuard()`（底部红条，不阻断使用）。
- Web / 桌面端 `cloudSaveState` 防抖合并写入（800ms）+ `flushCloudSave()` 关键路径立即落库。
- Web / 桌面端对话 `fetch` 超时（60s `AbortController`）+ 401 令牌刷新后自动重试一次。
- 新增治理文档：`docs/ARCHITECTURE.md`、`docs/STABILITY_RISKS.md`、`docs/VERSIONING.md`。

### Fixed
- 修复上游错误发生在响应头已发后再次 `writeHead` 导致容器崩溃（headers already sent）。
- 修复上游流中断抛未捕获异常击垮进程。
- 修复弱网/上游挂起时对话连接无限期挂起。

### Changed
- `zhhs01-agent/src/index.js` 重写 `handleChat` 流式与资源回收逻辑。

---

## [0.1.x] 历史归档（来自整改概览）

### [0.1.4] - 2026-08-13 · Agent 接入页整改
- Agent 列表增加删除按钮（仅自定义 Agent，默认实例 `zhhs_01` 不可删）。
- 移除「Agent 信息」卡片，清理相关死代码。
- 接入配置增加「描述（选填）」并补全名称持久化（`bindConfigEdit`）。
- BUILD_TAG 升至 `2026-08-13-0915`。

### [0.1.3] - 2026-08-12 · 双问题修复
- 修复 `zhhs_01` 聊天报「登录已失效」(401)：`/chat` 改为软鉴权，去除对匿名 key 的 JWT 强校验。
- 修复 `zhhs_02` 接入后对话页 Agent 选择器不显示：主页下拉改为动态渲染 `AGENT_LIST`，`sendHome` 改用选中 Agent 的 endpoint+botId。
- BUILD_TAG `1825`。

### [0.1.2] - 2026-08-12 · 401 invalid token 诊断
- 前端 `getAuthHeaders` 兼容 `access_token || accessToken`；探活/测试连接改为“收到 HTTP 响应即在线”。
- 代理 `/healthz` 移除 `requireAuth` 改为公开 200（待重新部署生效）。
- BUILD_TAG `2026-08-12-1800`。

### [0.1.1] - 2026-08-12 · 桌面端 npm start 修复
- 固化 Electron 镜像源 `electron_mirror`（.npmrc），根治 v43 checksum 校验失败与下载缓慢。
- 预下载正确二进制并清理陈旧缓存。

### [0.1.0] - 初始可用版本
- 三端基线：代理 SSE 透传、Web 单文件应用、Electron 桌面端（本地能力 + 文件附件）。
- CloudBase 用户名/密码登录、共享型 PG `user_state` 跨端同步（前端 rdb + RLS）。
- 对话、会话历史、Agent 接入与管理、下载桌面版入口。

---

## 模板（后续版本照此追加）

```
## [X.Y.Z] - YYYY-MM-DD
### Added
### Fixed
### Changed
### Removed
```
