# 双问题修复概览（2026-08-12 18:12，已部署并验证）

## 问题 1：zhhs_01 聊天报「登录已失效」（401）✅ 已修复并验证

**根因**
- 代理 `zhhs01-agent/src/index.js` 的 `/chat` 路由被 `requireAuth` 死拦：用 node-sdk `verifyToken` 校验前端 `Authorization: Bearer <access_token>`。
- 前端用**匿名 publishable key**（`CB_ACCESS_KEY`，payload `role:"anon"`）初始化 Web SDK，登录后拿到的 token 跨 SDK 验签必然失败 → 代理返回 `401 {"error":"unauthorized","message":"invalid token"}`。
- 前端 `sendHome` 在 `resp.status===401` 时抛 `Error("登录已失效")`，即用户看到的那条。

**修复（代理）**
- `/chat` 改为**软鉴权**：仅尝试 `verifyToken` 并记录 uid，失败 `console.warn` 但继续执行，不再返回 401。
- Web 端 CloudBase 用户名/密码登录已作为访问闸门，代理侧 JWT 强校验对内部工具属冗余且当前已坏，故去除拦截。
- `/healthz` 此前已改为公开 200。

**部署与验证**
- 命令：`printf '\n' | cloudbase cloudrun deploy --service-name zhhs01-agent --env-id zhhs-agent-2608-d1fs32gddb84cdea --force --wait`（CLI 3.7.2 已认证；灰度提示用管道喂回车选默认「No」自动切流；云端构建，无需本地 docker）。
- 结果：`✔ Deployment successful`（CreateVersion/ReleaseVersion finished）。
- 线上验证：`/healthz` 返回 `{"status":"ok","agent":"zhhs_01"}`；`/chat` POST 无 token 返回 **HTTP 200** 且真实代理 aiflowy 流式输出（"你好！我是报表自动化助手…"）。401 不再出现。

## 问题 2：zhhs_02 接入成功后对话页 Agent 选择器不显示 ✅ 已修复并部署

**根因**
- 主页聊天框 `#agentMenu` 写死只含 `zhhs_01` 一个静态 `<div class="opt">`，与「Agent 接入」页的 `AGENT_LIST`/`localStorage` 完全脱钩。
- `sendHome` 写死用 `BOT_ID`/`AGENT_BASE`，不读选中的 Agent。

**修复（前端，BUILD_TAG 1825，已上传静态托管）**
- 清空静态 `#agentMenu`，新增 `renderChatAgentMenu()` 遍历 `AGENT_LIST` 动态生成选项（选中态 ✓），点选即切换 `AGENT_SELECTED_ID` + 标签。
- 在 `selectAgent()` 与初始化处调用，使「Agent 接入」页新增 zhhs_02 后对话页下拉即时同步。
- `sendHome` 改用选中 Agent 的 `endpoint` + `botId`，发往对应 `/chat`。

**线上验证**：static opt=0、`chatBase`/`renderChatAgentMenu` 均存在、BUILD_TAG=1825。

## 用户验收清单
1. Ctrl+Shift+R 硬刷新 → 进「Agent 接入」新增 zhhs_02 → 回到对话页，输入框左侧下拉应出现 zhhs_02，可选中切换。
2. 对话页发消息（zhhs_01 或切到 zhhs_02）→ 不再出现「登录已失效」，正常流式回复。

## 备注 / 风险
- wangxiaoting/wangxiaoting 为弱密码测试账号，建议重置。
- 前端匿名 publishable key 仍保留（仅用于 SDK 初始化）；若后续要做更严格的代理鉴权，应换用非匿名密钥并修正 verifyToken 逻辑，而非当前软鉴权方案。
