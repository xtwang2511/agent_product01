# 版本迭代与分支管理规范

> 版本：v0.2.0　|　最后更新：2026-08-13　|　适用：zhhs01-agent / zhhs01-web / zhhs01-desktop 三端统一

本规范定义产品的版本号规则、分支模型、发布节奏、合并流程与回滚策略，目标是让项目**可有序演进、可回溯、可协同**。

---

## 1. 版本号规则

采用 **语义化版本（SemVer）** 统一三端：`<major>.<minor>.<patch>`。

| 位 | 含义 | 触发举例 |
|----|------|----------|
| major | 不兼容的架构/协议变更 | 鉴权体系重构、SSE 协议变更 |
| minor | 向后兼容的功能新增 | 新增看板/定时任务实装、桌面端新本地能力 |
| patch | 向后兼容的问题修复 | 401 修复、崩溃加固、UI 微调 |

- **当前版本**：`0.2.0`（错误处理与稳定性加固）。
- **构建标识 `BUILD_TAG`**（仅前端）：每次静态托管发布递增，格式 `YYYY-MM-DD-HHMM`，用于打破浏览器缓存。**改为发布脚本自动注入 Git 短哈希**，避免人工遗漏（见 R-18）。
- **标签（Git tag）**：`v<版本号>`（如 `v0.2.0`），打在 `main` 的发布提交上。

---

## 2. 分支模型（GitFlow-lite）

> 命名约定说明：标准 GitFlow 使用斜杠命名（如 `release/vX.Y.0`、`feature/xxx`）。
> 但**本工作环境（沙箱）的 git 对带斜杠的嵌套 ref 写入会被静默拦截**（exit 0 却不建 ref），
> 故本项目统一采用**扁平命名**（连字符代替斜杠）。推送到标准 Git 主机时如需恢复斜杠形式，
> 直接重命名分支即可，不影响流程语义。

```
main              —— 稳定可发布主干，受保护，只接收来自 release/hotfix 的合并
  └─ develop      —— 日常集成分支，接收 feature-xxx 合并
       └─ feature-xxx   —— 单需求/单模块开发（例：feature-agent-config）
       └─ fix-xxx       —— 非紧急缺陷修复
release-X.Y.0     —— 发布候选分支，只做缺陷修复与版本号定稿，验收后合回 main+develop
hotfix-X.Y.Z      —— 线上紧急修复，从 main 拉出，修复后合回 main+develop 并打补丁 tag
```

**约定：**
- `main` 与 `develop` 受保护：禁止直接 push，必须走 PR（见 §4）。
- 功能分支从 `develop` 拉，hotfix 从 `main` 拉。
- 分支生命周期随需求结束即删除（release/hotfix 合入后删除）。

---

## 3. 发布节奏

| 类型 | 节奏 | 说明 |
|------|------|------|
| 常规迭代 | 双周（Sprint）一个 `minor` | develop → release → main，每迭代一个候选版本 |
| 紧急修复 | 按需（hotfix） | 线上 P0/P1 问题，小时级响应，单独 `patch` |
| 代理/桌面 | 跟随前端版本号 | 代理与桌面打包随同一版本号发布，便于回溯对齐 |

**发布检查清单（Release Checklist）：**
1. `develop` 已通过自测与 Code Review；
2. 从 `develop` 拉 `release-X.Y.0`（扁平命名），更新版本号与 `CHANGELOG.md`；
3. 静态托管上传 `web` + 桌面端重新打包上传（同步 `BUILD_TAG`）；
4. 代理 `cloudbase cloudrun deploy`（如涉及）；
5. 冒烟验证（登录、对话、Agent 接入、跨端同步）；
6. 合入 `main` 并打 `vX.Y.0` tag，合回 `develop` 防漂移。

---

## 4. 合并与 PR 流程

1. 开发者在 `feature/*` 或 `fix/*` 完成开发并自测；
2. 向 `develop` 提 PR，模板包含：变更摘要、影响范围、自测结果、关联风险编号（如 R-02）；
3. **质量门禁（必须全绿）**：
   - 代码自查（无 `console.log` 调试残留、关键路径有 try/catch）；
   - 至少 1 名评审 approve（核心模块需 2 名）；
   - 构建通过（桌面端 `npm run dist` 成功）；
4. 合并方式：**Squash Merge**，保持 `develop`/`main` 线性、可读；
5. `release/*` 与 `hotfix/*` 合并回 `main` 后，再合并回 `develop`（或 `git merge main` 到 develop）防止版本漂移。

---

## 5. 回滚策略

| 组件 | 回滚方式 |
|------|----------|
| 代理（CloudRun） | `cloudbase cloudrun deploy --version <旧版本>` 或控制台「版本/流量」切回上一版；tag 对应源码 |
| Web 静态托管 | 保留历史构建物，按 `BUILD_TAG` 回退；或用托管版本化管理 |
| 桌面端 | 重新分发上一版 `setup.exe`（建议托管多版本目录 + 版本清单） |
| 数据库 | `user_state` 结构变更须向后兼容；破坏性变更走独立迁移脚本与备份 |

**原则**：任何发布都对应一个可追溯的 `vX.Y.Z` tag 与 `CHANGELOG` 条目；回滚前确认无破坏性schema变更。

---

## 6. 关联文档

- `ARCHITECTURE.md`：逻辑架构与依赖基线
- `STABILITY_RISKS.md`：风险编号（R-xx）与修复状态
- `CHANGELOG.md`：按版本记录变更内容
- `.github/`（建议补充）：PR 模板、CI 构建与发布工作流
