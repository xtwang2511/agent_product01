# Agent 接入页整改（2026-08-13）

## 改动概览

对 `zhhs01-web/index.html`（Agent 接入视图）做了三处整改，BUILD_TAG 升至 `2026-08-13-0915`，已上传 CloudBase 静态托管并线上验证。

### 1. Agent 列表增加删除按钮
- `renderAgentList()` 为每个**自定义（非 builtin）** Agent 行追加 `.i-del` 删除按钮（默认透明、hover 显示、红色危险态）。
- 新增 `deleteAgent(id)`：删除前 `confirm` 二次确认；删除后写回 `localStorage`；若删掉的是当前选中项，自动回退到列表首项（builtin `zhhs_01` 始终在首，不会清空）。
- **默认实例 `zhhs_01` 不显示删除按钮**——避免「删了又随刷新复活」的困惑（DEFAULT_AGENTS 在 `loadAgents` 始终重新前置）。
- 删除按钮点击 `stopPropagation`，不触发整行选中。

### 2. 删除「Agent 信息」卡片
- 移除右侧 `接入配置` 卡下方的整个「Agent 信息」卡片（名称/部署/描述/能力标签）。
- 同步清理：JS `selectAgent()` 中 `infoName`/`infoDesc` 的赋值；CSS 中仅服务于该卡片的 `.tag-row`/`.tag`/`.meta-grid` 死规则（共 8 行）。
- 线上 grep 确认 `infoName`/`infoDesc`/`Agent 信息` 0 处残留。

### 3. 接入配置增加「描述（选填）」
- 接入配置卡内新增 `cfgDesc` 文本域（选填）。
- 添加 Agent 弹窗内新增 `newDesc` 文本域（选填），创建时写入 `newAgent.desc` 并持久化。
- `selectAgent()` 选中实例时回填 `cfgDesc`。
- 新增 `bindConfigEdit()`：配置卡的「名称」与「描述」输入实时写回当前选中 Agent 并 `saveAgents()`（名称此前是输入框但不落库，本次一并补上持久化）。

## 验证
- 本地 grep：旧 info* 引用 0；`cfgDesc`/`newDesc` 各 1；`deleteAgent` 2 处；`i-del` 5 处；`bindConfigEdit` 2 处。
- 线上 curl：BUILD_TAG、cfgDesc/newDesc 文本域、delBtn 模板、deleteAgent 函数均在线；`infoName`/`Agent 信息` 0 残留。

## 用户验收点
1. **Ctrl+Shift+R 硬刷新** → 进「Agent 接入」，鼠标悬停自定义 Agent（如 zhhs_02）右侧出现 × 按钮；点 × 确认后该 Agent 从列表消失、对话页下拉同步移除。
2. 右侧只剩「接入配置」一张卡，含 botid / 名称 / 接入点 URL / **描述（选填）** / 测试连接。
3. 添加 Agent 弹窗可填描述；创建后在配置卡可见/可编辑，改动自动保存（刷新不丢）。
