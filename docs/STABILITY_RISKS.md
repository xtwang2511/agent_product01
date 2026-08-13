# 稳定性风险与异常分支清单

> 版本：v0.2.0　|　最后更新：2026-08-13　|　配套：ARCHITECTURE.md / VERSIONING.md

本文登记三端在高并发、边界场景下的潜在崩溃点与异常分支，按严重级别给出根因与修复状态。
严重级别：**P0**（会导致进程/容器崩溃或全局不可用）、**P1**（局部功能不可用或数据风险）、**P2**（体验/健壮性隐患）。

---

## 0. 已修复（v0.2.0 加固）

| 编号 | 位置 | 风险 | 级别 | 修复 |
|------|------|------|------|------|
| R-01 | `zhhs01-agent/src/index.js` | 无 `process.on('uncaughtException'/'unhandledRejection')` 与 `server.on('error')`，任意未捕获异常击垮容器 → 全局 502 | P0 | 已加进程级兜底 + 优雅退出；请求路径异常由各 handler 兜住 |
| R-02 | agent `handleChat` | 上游错误发生在响应头已发出后，`upstream.on('error')` 再次 `sendJson` → “headers already sent” 崩溃 | P0 | `fail()` 检测 `headersSent/writableEnded`，仅 `res.end()` |
| R-03 | agent `handleChat` | `upRes`（上游流）无 `error` 监听，流中断抛未捕获异常 → 崩溃 | P0 | 新增 `upRes.on('error')` → 安全 `res.end()` |
| R-04 | agent `handleChat` | 慢/挂连接长期占用 fd，高并发下耗尽；无超时 | P1 | 上游 60s `setTimeout`(504) + 客户端断开 `req/res` 中止 |
| R-05 | agent | 无限并发 SSE 流压垮上游与进程 | P1 | `activeChats` 计数，`MAX_CONCURRENT_CHATS=200`，超出 429 |
| R-06 | agent | 请求体无上限保护之外，`req.destroy()` 后无 error/aborted 处理可能抛 ECONNRESET | P1 | `req.on('error'/'aborted')` + `res.on('close')` 统一回收 |
| R-07 | web/desktop `index.html` | 全局无 `window.onerror`/`unhandledrejection`，事件回调异常静默或白屏 | P1 | 新增 `installGlobalErrorGuard()`，底部红条兜底不阻断使用 |
| R-08 | web/desktop | `cloudSaveState` 每次会话/编辑都立即 rdb upsert，写放大 + 并发覆盖风险 | P1 | 防抖 800ms 合并（`flushCloudSave()` 供关键路径立即落库） |
| R-09 | web/desktop `sendHome` | 对话 `fetch` 无超时，弱网/上游挂起时连接无限期挂起 | P1 | `fetchWithTimeout` 60s `AbortController` |
| R-10 | web/desktop | 401 后直接报错，令牌过期需用户手动重发 | P2 | 刷新会话后自动重试一次 |

---

## 1. 代理端（zhhs01-agent）待持续关注

| 编号 | 风险点 / 异常分支 | 触发场景 | 级别 | 建议 |
|------|-------------------|----------|------|------|
| R-11 | `requireAuth` 为死代码，软鉴权逻辑分散 | 维护混淆，未来改强鉴权易漏改 | P2 | 收敛鉴权逻辑到单一函数，软/强可配置 |
| R-12 | `/healthz` 仅 liveness，aiflowy 不可用仍 200 | 监控误判“正常”，实则对话失败 | P2 | 增加独立 `/readyz` 做依赖探测（不接入存活探针避免重启循环） |
| R-13 | `API_KEY` 缺失返回 500，但无启动期自检 | 部署漏配密钥，运行时才报错 | P2 | 启动打印配置自检，缺失则 `console.warn` 并暴露 `/healthz` 标记 |
| R-14 | 单进程无横向扩展/健康检查接入网关限流 | 流量突增超过单实例容量 | P1 | CloudRun 实例自动扩缩 + 网关层限流；本服务 429 作为二级防护 |

---

## 2. Web / 桌面端待持续关注

| 编号 | 风险点 / 异常分支 | 触发场景 | 级别 | 建议 |
|------|-------------------|----------|------|------|
| R-15 | `syncFromCloud` 用云端整份覆盖本地，云端为空/陈旧会清掉本地自定义 Agent | 多端/多标签并发编辑，last-write-wins 丢失数据 | P1 | 合并策略：云端优先但保留本地新增；加版本号/时间戳合并 |
| R-16 | 多标签页并发 `setConversations` + `cloudSaveState` 竞态 | 两标签各写一份，互相覆盖 | P1 | 写入前读最新再合并；或加标签页锁（BroadcastChannel） |
| R-17 | `applyAuthUI` 读 `data.session.user` 未做空守卫 | 异常登录态下赋值崩溃（当前 authUserName 已兜底，仍建议显式保护） | P2 | `const user = data?.session?.user || {}` 显式兜底 |
| R-18 | `BUILD_TAG` 依赖人工递增，易漏导致用户命中旧缓存 | 发布忘记加 TAG，用户看到旧逻辑/旧 bug | P2 | 发布脚本自动注入 Git 短哈希或 CI 构建号 |
| R-19 | 桌面端 `local:runCommand` 仅 Windows `cmd.exe` 适配 | macOS/Linux 桌面打包后命令执行失效 | P2 | 按 `process.platform` 选择 shell（sh / bash） |
| R-20 | 桌面端 `local:readFile` 无路径白名单，可读任意文件 | 本地 Agent 被诱导读取敏感文件 | P2 | 增加用户目录默认范围 + 越界二次确认提示 |
| R-21 | `startDownload` 仅 HEAD 探测，无超时 | 安装包缺失时浏览器挂起 | P2 | 加 `AbortController` 超时与失败兜底 |

---

## 3. 高并发与边界场景专项

| 场景 | 现状（v0.2.0） | 残余风险 | 处置 |
|------|----------------|----------|------|
| 大量长连接 SSE | 并发上限 200 + 超时回收 | 单实例上限固定，超限 429 | CloudRun 自动扩缩 + 网关限流（R-14） |
| 客户端中途断开 | `req/res` close 中止上游 | 极少残留半开连接 | 已覆盖 |
| 超大请求体 | 1MB 上限 413 | 正常业务不会触达 | 已覆盖 |
| 上游超时/断流 | 60s 504 + 安全 end | 偶发 | 已覆盖 |
| 令牌过期 | 401 自动重试一次 | 重试后仍过期需手动登录 | 已覆盖 |
| 云端写入竞态 | 防抖合并 | 多标签仍可能覆盖（R-16） | 后续合并策略 |
| 容器异常崩溃 | 进程兜底 + CloudRun 重启 | 崩溃瞬间在途请求失败 | 已极大降低概率 |

---

## 4. 验证建议

1. **代理单测/压测**：用 `ab`/`k6` 对 `/chat` 并发 300 长连接，观察是否出现 502、内存增长、fd 数；模拟上游 `kill -9` 验证 `upRes.on('error')` 不再崩溃。
2. **异常注入**：人为在 `handleChat` 抛错，确认进程不被击垮（仅日志记录）。
3. **前端边界**：断网发消息（验证全局兜底红条）、快速连续发送（验证 `busy` 与超时）、令牌过期（验证 401 重试）。
4. **多标签**：两个标签分别编辑 Agent，验证云端合并是否符合预期。
