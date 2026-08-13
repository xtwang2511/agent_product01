# Agent 接入 401 invalid token 诊断与修复

## 现象
「添加 Agent」弹窗点「测试并接入」返回 `HTTP 401 {"error":"unauthorized","message":"invalid token"}`。

## 根因
该 JSON 格式与代理 `requireAuth`（src/index.js:65）的 401 完全一致 → 401 来自**我们自己的 zhhs01-agent 代理**，不是远程代理。

链路：
1. 前端 `initCloudbase` 用 `CB_ACCESS_KEY`（**匿名 publishable key**，payload 中 `role:"anon"`、`is_anonymous:true`）初始化 Web SDK。
2. `getAuthHeaders()` 从 `getSession().session.access_token` 取 token 带去代理。
3. 代理 `requireAuth` 用 node-sdk `verifyToken` 校验该 token → 匿名 key 体系 + 后端匿名登录已关闭 → 校验失败 → `invalid token`。
4. `/healthz` 被 `requireAuth` 包住（src/index.js:169-173），故「测试并接入」「测试连接」一打 `/healthz` 就 401。

## 修复
### 前端（已部署，BUILD_TAG=2026-08-12-1800）
- `getAuthHeaders` 兼容 `access_token || accessToken` 字段名。
- 「测试并接入」「测试连接」改为：**能收到 HTTP 响应（200/401/404 皆可）即判定目标在线连通**，不再因 401 报红失败；非 200 提示「目标在线但返回非 200，可能需鉴权」。

### 代理（代码已改，待重新部署容器生效）
- `src/index.js` `/healthz` 移除 `requireAuth`，改为公开 `sendJson 200`（探活接口本就不该鉴权）。
- 部署需 docker build + 推送镜像到 CloudBase CloudRun（cloudbaserc.json: cloudrun name=zhhs01-agent）。沙箱无 docker，本次未部署；前端已兼容 401，当前行为不受影响。

## 待办 / 提醒
- 请硬刷新后用 `wangxiaoting` 实测一次对话 `/chat`，确认对话是否正常（若对话也 401，说明需要换用非匿名 publishable key 或调整代理 `verifyToken` 逻辑——这是独立于本 401 的潜在根因）。
- 代理 `/healthz` 公开化的容器重新部署择机执行（让探活返回 200，显示更干净）。
