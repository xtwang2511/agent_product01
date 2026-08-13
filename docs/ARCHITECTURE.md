# zhhs_01 智能对话工作台 · 代码逻辑架构

> 版本：v0.2.0　|　最后更新：2026-08-13　|　维护：海底大大

本文梳理 `zhhs01-agent` / `zhhs01-web` / `zhhs01-desktop` 三端的逻辑架构、模块依赖、核心业务流程与数据模型，作为后续稳定性治理与版本迭代的基线文档。

---

## 1. 产品定位与部署拓扑

一个基于 **CodeBuddy Agent SDK + CloudBase** 的桌面 / Web 智能对话工作台。前端（Web 与桌面共用同一套逻辑）通过云端代理 `zhhs01-agent` 与 aiflowy 机器人对话，登录态与操作记录由 CloudBase 原生 Auth + 共享型 PostgreSQL（RLS 隔离）承载。

```svg
<svg viewBox="0 0 680 360" xmlns="http://www.w3.org/2000/svg" font-family="Inter, sans-serif">
  <defs>
    <marker id="arr" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
      <path d="M0,0 L9,4.5 L0,9 z" fill="#6B7075"/>
    </marker>
  </defs>

  <!-- 客户端 -->
  <rect x="14" y="20" width="200" height="150" rx="12" fill="#FFFFFF" stroke="#E5E5E5"/>
  <text x="114" y="42" text-anchor="middle" font-size="13" font-weight="600" fill="#18191C">客户端（Web / 桌面）</text>
  <rect x="30" y="58" width="168" height="26" rx="6" fill="#F2F3F5"/><text x="114" y="75" text-anchor="middle" font-size="11" fill="#18191C">index.html（单文件应用）</text>
  <rect x="30" y="92" width="168" height="26" rx="6" fill="#F2F3F5"/><text x="114" y="109" text-anchor="middle" font-size="11" fill="#18191C">CloudBase Web SDK（auth+rdb）</text>
  <rect x="30" y="126" width="168" height="26" rx="6" fill="#F2F3F5"/><text x="114" y="143" text-anchor="middle" font-size="11" fill="#18191C">localStorage（离线缓存）</text>

  <!-- 代理 -->
  <rect x="270" y="20" width="180" height="150" rx="12" fill="#FFFFFF" stroke="#18191C" stroke-width="1.5"/>
  <text x="360" y="42" text-anchor="middle" font-size="13" font-weight="600" fill="#18191C">zhhs01-agent（CloudRun）</text>
  <rect x="286" y="58" width="148" height="26" rx="6" fill="#ECFDF5"/><text x="360" y="75" text-anchor="middle" font-size="11" fill="#18191C">/chat（SSE 透传）</text>
  <rect x="286" y="92" width="148" height="26" rx="6" fill="#ECFDF5"/><text x="360" y="109" text-anchor="middle" font-size="11" fill="#18191C">/healthz（探活）</text>
  <rect x="286" y="126" width="148" height="26" rx="6" fill="#ECFDF5"/><text x="360" y="143" text-anchor="middle" font-size="11" fill="#18191C">软鉴权 + 并发保护</text>

  <!-- 上游 -->
  <rect x="510" y="20" width="156" height="150" rx="12" fill="#FFFFFF" stroke="#E5E5E5"/>
  <text x="588" y="42" text-anchor="middle" font-size="13" font-weight="600" fill="#18191C">aiflowy</text>
  <rect x="526" y="58" width="124" height="26" rx="6" fill="#F2F3F5"/><text x="588" y="75" text-anchor="middle" font-size="11" fill="#18191C">/bot/chat（SSE）</text>
  <rect x="526" y="92" width="124" height="26" rx="6" fill="#F2F3F5"/><text x="588" y="109" text-anchor="middle" font-size="11" fill="#18191C">BotID + ApiKey</text>
  <rect x="526" y="126" width="124" height="26" rx="6" fill="#F2F3F5"/><text x="588" y="143" text-anchor="middle" font-size="11" fill="#18191C">多轮上下文</text>

  <!-- 云端底座 -->
  <rect x="14" y="210" width="652" height="120" rx="12" fill="#FAFAFA" stroke="#E5E5E5"/>
  <text x="34" y="232" font-size="12" font-weight="600" fill="#18191C">CloudBase 底座（环境 zhhs-agent-2608-d1fs32gddb84cdea · 上海）</text>
  <rect x="34" y="246" width="190" height="34" rx="8" fill="#FFFFFF" stroke="#E5E5E5"/><text x="129" y="267" text-anchor="middle" font-size="11" fill="#18191C">原生 Auth（用户名/密码）</text>
  <rect x="240" y="246" width="200" height="34" rx="8" fill="#FFFFFF" stroke="#E5E5E5"/><text x="340" y="267" text-anchor="middle" font-size="11" fill="#18191C">共享型 PG · user_state（RLS）</text>
  <rect x="456" y="246" width="190" height="34" rx="8" fill="#FFFFFF" stroke="#E5E5E5"/><text x="551" y="267" text-anchor="middle" font-size="11" fill="#18191C">静态托管（Web 站点）</text>

  <!-- 连线 -->
  <line x1="214" y1="95" x2="268" y2="95" stroke="#6B7075" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="450" y1="95" x2="508" y2="95" stroke="#6B7075" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="114" y1="170" x2="114" y2="208" stroke="#6B7075" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="360" y1="170" x2="360" y2="208" stroke="#6B7075" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="588" y1="170" x2="588" y2="208" stroke="#6B7075" stroke-width="1.5" marker-end="url(#arr)"/>
</svg>
```

---

## 2. 三端职责划分

| 端 | 技术形态 | 职责 | 关键文件 |
|----|----------|------|----------|
| **zhhs01-web** | CloudBase 静态托管单文件应用 | 用户界面、登录鉴权、会话/ Agent 管理、云端状态同步 | `index.html`、`cloudbase.bundle.js` |
| **zhhs01-desktop** | Electron（主进程 + 渲染进程） | 复用 Web 逻辑；主进程经 IPC 暴露本地能力（文件读写、命令执行） | `main.js`、`preload.js`、`renderer/index.html` |
| **zhhs01-agent** | CloudBase CloudRun（Node HTTP） | SSE 代理：转发 `/chat` 至 aiflowy、透传流式响应、探活 | `src/index.js` |

> 注：`zhhs01-desktop/renderer/index.html` 与 `zhhs01-web/index.html` 为同源同步副本；任何前端改动须两端同步并更新 `BUILD_TAG` 与重新打包（桌面端）。

---

## 3. 模块依赖关系

```svg
<svg viewBox="0 0 680 250" xmlns="http://www.w3.org/2000/svg" font-family="Inter, sans-serif">
  <defs><marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="#6B7075"/></marker></defs>
  <rect x="20" y="30" width="150" height="40" rx="10" fill="#FFFFFF" stroke="#18191C" stroke-width="1.5"/><text x="95" y="54" text-anchor="middle" font-size="12" fill="#18191C">UI 视图层</text>
  <rect x="20" y="100" width="150" height="40" rx="10" fill="#FFFFFF" stroke="#E5E5E5"/><text x="95" y="124" text-anchor="middle" font-size="12" fill="#18191C">业务流模块</text>
  <rect x="20" y="170" width="150" height="40" rx="10" fill="#FFFFFF" stroke="#E5E5E5"/><text x="95" y="194" text-anchor="middle" font-size="12" fill="#18191C">存储/通信</text>

  <rect x="265" y="30" width="160" height="40" rx="10" fill="#FFFFFF" stroke="#E5E5E5"/><text x="345" y="54" text-anchor="middle" font-size="12" fill="#18191C">CloudBase Web SDK</text>
  <rect x="265" y="100" width="160" height="40" rx="10" fill="#FFFFFF" stroke="#E5E5E5"/><text x="345" y="124" text-anchor="middle" font-size="12" fill="#18191C">zhhs01-agent 代理</text>
  <rect x="265" y="170" width="160" height="40" rx="10" fill="#FFFFFF" stroke="#E5E5E5"/><text x="345" y="194" text-anchor="middle" font-size="12" fill="#18191C">aiflowy 上游</text>

  <rect x="500" y="30" width="160" height="40" rx="10" fill="#FFFFFF" stroke="#E5E5E5"/><text x="580" y="54" text-anchor="middle" font-size="12" fill="#18191C">CloudBase PG</text>
  <rect x="500" y="100" width="160" height="40" rx="10" fill="#FFFFFF" stroke="#E5E5E5"/><text x="580" y="124" text-anchor="middle" font-size="12" fill="#18191C">localStorage</text>
  <rect x="500" y="170" width="160" height="40" rx="10" fill="#FFFFFF" stroke="#E5E5E5"/><text x="580" y="194" text-anchor="middle" font-size="12" fill="#18191C">Electron IPC</text>

  <line x1="170" y1="50" x2="263" y2="50" stroke="#6B7075" stroke-width="1.5" marker-end="url(#a2)"/>
  <line x1="170" y1="120" x2="263" y2="120" stroke="#6B7075" stroke-width="1.5" marker-end="url(#a2)"/>
  <line x1="170" y1="190" x2="263" y2="190" stroke="#6B7075" stroke-width="1.5" marker-end="url(#a2)"/>
  <line x1="425" y1="50" x2="498" y2="50" stroke="#6B7075" stroke-width="1.5" marker-end="url(#a2)"/>
  <line x1="425" y1="120" x2="498" y2="120" stroke="#6B7075" stroke-width="1.5" marker-end="url(#a2)"/>
  <line x1="425" y1="120" x2="498" y2="190" stroke="#6B7075" stroke-width="1.5" marker-end="url(#a2)"/>
  <line x1="180" y1="70" x2="180" y2="98" stroke="#6B7075" stroke-width="1.5" marker-end="url(#a2)"/>
  <line x1="180" y1="140" x2="180" y2="168" stroke="#6B7075" stroke-width="1.5" marker-end="url(#a2)"/>
</svg>
```

**依赖要点：**
- 业务流模块（会话、Agent 管理、云端同步）是中枢，向上驱动 UI，向下依赖 SDK / 代理 / 存储。
- 跨端互通的关键路径：`cloudSaveState`（rdb upsert）→ PG `user_state`（RLS `auth.uid()` 隔离）→ `syncFromCloud`（登录后拉取覆盖本地）。`localStorage` 仅作离线缓存与即时读写。
- 桌面端独有的 `Electron IPC` 依赖：本地文件读写、命令执行均经 `preload` 桥 `window.electronAPI`，主进程二次确认。

---

## 4. 核心业务流程

### 4.1 登录鉴权（路由守卫）
`initCloudbase()` → `signInWithPassword()` → `applyAuthUI()`（显示/隐藏 `#loginScreen`，路由守卫）→ `syncFromCloud()`（rdb 拉取跨端数据）。匿名 publishable key 仅用于 SDK 初始化；真实访问闸门是 CloudBase 用户名/密码登录。

### 4.2 对话（SSE 透传）
`sendHome(text)` → `fetch(/chat, SSE)` → 逐块解析 `data: {...}` → `type==="MESSAGE"` 累加快照/思考 → 渲染气泡 → 持久化到 `currentMessages` + `localStorage` + 云端。异常在 `catch` 中渲染诊断框（含错误类型、目标、协议、构建号），`finally` 复位 `busy`。

### 4.3 云端状态同步（双写 + 登录拉取）
- 写：`setConversations` / `saveAgents` 触发 `cloudSaveState()`（rdb upsert 整份 `{conversations, agents}`）。
- 读：登录成功 `syncFromCloud()` 用云端覆盖本地（builtin 始终前置）。
- 隔离：PG RLS 以 `auth.uid()` 行级隔离，不同账号互不可见。

### 4.4 Agent 接入与管理
`loadAgents()`（localStorage + 云端） → `renderAgentList()` / `renderChatAgentMenu()`（动态选项）→ `submitAddAgent()`（先 `GET /healthz` 探活，收到任何 HTTP 响应即判定在线）→ `saveAgents()`。`deleteAgent()` 仅对自定义 Agent 生效，删除当前选中项自动回退首项。

### 4.5 桌面端本地能力
渲染进程调用 `window.electronAPI.*` → 主进程 `ipcMain.handle('local:*')`：文件选择/读取（带 2MB 文本 / 8MB 二进制上限）、目录列举、文件写入（二次确认）、**命令执行 `runCommand`（30s 超时 + 二次确认弹窗）**、系统信息。

---

## 5. 数据模型与关键常量

| 类别 | 键 / 常量 | 说明 |
|------|-----------|------|
| 会话缓存 | `zhhs01.conversations` | localStorage 中的会话列表 |
| 自定义 Agent | `zhhs01.agents` | localStorage 中的自定义 Agent |
| 云端表 | `user_state(uid PK, payload jsonb, updated_at)` | 按用户隔离的操作记录（RLS） |
| 默认 Agent | `DEFAULT_AGENTS` / `zhhs_01`（builtin） | builtin 不可删、始终前置 |
| 代理端点 | `AGENT_BASE`（web）/ `DEFAULT_AGENT_ENDPOINT` | zhhs01-agent 静态托管地址 |
| 默认 BotID | `438168191460208640` | aiflowy 机器人 |
| 缓存破冰 | `BUILD_TAG` | 打破浏览器静态缓存，每次前端发布递增 |
| 鉴权密钥 | `CB_ACCESS_KEY`（匿名 publishable） | 仅前端初始化用，不可作强鉴权 |

---

## 6. 关键技术决策与遗留问题

1. **软鉴权**：代理 `/chat` 不做 JWT 强校验（匿名 key 体系导致合法对话被 401）。属过渡方案，长期应换非匿名密钥并修正校验逻辑。
2. **云端同步走前端 rdb 直连**：共享型 PG 无法用 `pg.Pool` 直连，容器内 node-sdk rdb 取不到密钥会崩溃，故改为前端会话身份直连 + RLS。代理 `/api/state` 已撤为 501。
3. **CORS 宽松**：代理与 `/healthz` 允许 `*` 跨域，作为兜底。生产可按托管域名收紧。
4. **遗留**：弱密码测试账号（`wangxiaoting`）；`BUILD_TAG` 依赖人工递增；前端无自动化测试与 CI。

> 下一步稳定性与版本治理详见 `docs/STABILITY_RISKS.md` 与 `docs/VERSIONING.md`。
