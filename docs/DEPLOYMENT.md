# 部署方案 · 静态托管 + 云托管 + 云函数

> 版本：v2.0（最终版）　|　最后更新：2026-08-18　|　维护：海底大大
> 适用环境：`zhhs-agent-2608-d1fs32gddb84cdea`（CloudBase 上海）

本文给出整套项目的**目录划分**与**三类托管形态的统一部署方案**。目标：让静态站点、云托管服务、云函数各自有清晰归属，用一条命令或一个脚本完成发布，并把密钥、缓存、回滚讲清楚。本版整合历次迭代：P0/P1 缺陷修复、CORS 收紧、桌面端同步机制、GitHub Actions CI。

---

## 1. 现状与目标

当前仓库根目录按托管形态平铺了三个目标 + 一个桌面端：

| 目录 | 形态 | 说明 |
|------|------|------|
| `web/` | 静态托管（Static Hosting） | 单文件前端 `index.html` + `cloudbase.bundle.js` + `lib/` 离线资源 |
| `backend/cloudrun/` | 云托管（CloudRun 容器） | SSE 代理，转发 `/chat` 到 aiflowy；自带 `cloudbaserc.json` + `Dockerfile`；CORS 已按白名单收紧 |
| `backend/functions/zhipu-proxy/` | 云函数（HTTP Function） | SSE 代理，转发到 `open.bigmodel.cn`；带 `scf_bootstrap` + `APP_TOKEN` 轻量鉴权 |
| `desktop/` | Electron 打包（独立交付） | 复用 Web 逻辑，单独打 exe，**不走 CloudBase 托管** |

**协调层（本方案已全部落地）：**
1. 根级 `cloudbaserc.json` 统一声明 `envId` + 云函数（`functionRoot: "backend/functions"`）。
2. `scripts/deploy.sh` 统一编排三步发布（支持 `web|agent|fn|all`），含 `BUILD_TAG` 自动递增、renderer 同步检查、部署后冒烟校验。
3. `.github/workflows/deploy.yml` 接入 GitHub Actions，push main 自动发「静态托管 + 云函数」。
4. 发布/回滚/缓存刷新规范见第 8 章。

---

## 2. 三类托管形态的边界（关键决策）

> 原则：**HTTP 云函数优先**。只有需求真正需要时才上云托管。但有 `Dockerfile` ≠ 必须上云托管。

| 目标 | 形态 | 为什么是这个形态 | 能否替换 |
|------|------|------------------|----------|
| `web` | 静态托管 | 纯前端静态资源，CDN 加速最划算 | — |
| `zhhs01-agent`（backend/cloudrun） | 云托管容器 | 做 **SSE 长连接**透传到 aiflowy，需要常驻稳定进程 + 长连接 | 不建议；SSE 长连接是云托管的正当场景 |
| `zhipu-proxy` | 云函数（HTTP Function） | **必须**是云函数：云托管容器**无公网出网**，而它必须访问 `open.bigmodel.cn`；云函数默认带公网出网 | **不能**改成云托管，否则出网被拦截 |

⚠️ **硬约束**：`zhipu-proxy` 若误迁到云托管，直连 `open.bigmodel.cn` 会被卡 30s 超时（历史已踩坑）。保持云函数不动。

---

## 3. 推荐目录划分

### 3.1 目录结构（已按语义化命名落地）

```
agent_product01/
├── .github/
│   └── workflows/deploy.yml   # CI：push main 自动发 web + fn
├── cloudbaserc.json           # 根配置：envId + functionRoot(backend/functions) + zhipu-proxy 声明
├── scripts/
│   └── deploy.sh              # 统一编排（静态/云托管/云函数 三步 + 冒烟）
├── docs/
│   ├── ARCHITECTURE.md        # 已有
│   ├── DEPLOYMENT.md          # 本文件
│   ├── STABILITY_RISKS.md     # 已有
│   └── VERSIONING.md          # 已有
├── web/                       # 静态托管根（直接上传此目录）
│   ├── index.html             # 单文件应用 + BUILD_TAG 缓存破冰
│   ├── cloudbase.bundle.js
│   ├── lib/  assets/
│   └── zhhs-logo.png
├── backend/
│   ├── cloudrun/              # 云托管（CloudRun）：保留自带 cloudbaserc.json
│   │   ├── Dockerfile  src/  agents/  cloudbaserc.json  scf_bootstrap
│   └── functions/             # 云函数根（functionRoot）
│       └── zhipu-proxy/       # HTTP 云函数：index.js + scf_bootstrap
└── desktop/                   # Electron：独立打包，单独交付，不进托管
    └── renderer/index.html    # 与 web/index.html 同源同步副本
```

### 3.2 目录重命名（已落地 ✅）

已完成 `git mv` 重命名，所有引用已同步更新：

| 原名 | 新名 | 理由 |
|------|------|------|
| `zhhs01-web` | `web/` | 静态托管根 |
| `zhhs01-agent` | `backend/cloudrun/` | 云托管服务 |
| `cloudfunctions` | `backend/functions/` | 云函数根 |
| `zhhs01-desktop` | `desktop/` | Electron |

> 同步更新的配置：`cloudbaserc.json` 的 `functionRoot` → `backend/functions`、`deploy.sh` 全部路径、CI workflow 的 `paths` 过滤、本文档全量引用。

---

## 4. 根级 `cloudbaserc.json`（协调层）

放在仓库根，声明环境 ID、云函数清单。云托管（`backend/cloudrun`）不在此文件里——它用自己的 `backend/cloudrun/cloudbaserc.json` 部署，避免 cwd 冲突。

```json
{
  "envId": "zhhs-agent-2608-d1fs32gddb84cdea",
  "functionRoot": "backend/functions",
  "functions": [
    {
      "name": "zhipu-proxy",
      "runtime": "Nodejs18.15",
      "timeout": 120,
      "memorySize": 512,
      "isHTTP": true,
      "envVariables": {
        "ZHIPU_ENDPOINT": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        "APP_TOKEN": "zhhs-yx-2608"
      },
      "ignore": [".git/**", "*.md"]
    }
  ]
}
```

⚠️ **`ZHIPU_API_KEY` 不要写进本文件/仓库**（仓库 public）。它通过 CloudBase 控制台「函数环境变量」或 `tcb secrets set` 注入，函数代码已从 `process.env.ZHIPU_API_KEY` 读取。

---

## 5. 部署流程（三步，各自独立可执行）

> 前置：`npm i -g @cloudbase/cli`（即 `tcb`），`tcb login`，`tcb env use zhhs-agent-2608-d1fs32gddb84cdea`。
> 本会话已连接 CloudBase MCP，可用 `manageHosting` / `manageCloudRun` / `manageFunctions` 替代 CLI；CI/本地用下方 CLI 命令。

### 5.1 静态托管 `web`

```bash
cd web
# 确认托管已开启（未开通会自动激活）
tcb hosting detail --env-id zhhs-agent-2608-d1fs32gddb84cdea
# 上传整个目录到托管根（_online_index.html 历史副本已删除，不再需要排除逻辑）
tcb hosting deploy ./ --env-id zhhs-agent-2608-d1fs32gddb84cdea --yes
# 设置 SPA（单页应用）路由：404 也回 index.html
# 控制台「静态托管 → 基础设置」设 indexDocument=index.html, errorDocument=index.html
# 或 MCP：setWebsiteDocument({ indexDocument:"index.html", errorDocument:"index.html" })
# 校验
tcb hosting list --env-id zhhs-agent-2608-d1fs32gddb84cdea
```

> 浏览器访问地址：`https://<envId>.tcloudbaseapp.com/`（静态托管 CDN 域名）。
> 部署前 `BUILD_TAG` 需递增（脚本已自动处理，见第 6 章）。

### 5.2 云托管 `zhhs01-agent`（CloudRun 容器）

> ⚠️ **cwd 约束**：云托管必须在 `backend/cloudrun/` 目录下执行（该目录有自己的 `cloudbaserc.json` 声明 `cloudrun.name`）。**不要**在仓库根目录跑 `tcb cloudrun deploy`，否则会读根 `cloudbaserc.json`（无 cloudrun 段）导致失败。

```bash
cd backend/cloudrun
# 新环境首部署需先开通云托管（控制台 环境→云托管→开通，或 MCP initEnv）
# 容器型部署：监听 PORT（代码已用 process.env.PORT || 9000）
tcb cloudrun deploy --service-name zhhs01-agent \
  --env-id zhhs-agent-2608-d1fs32gddb84cdea --force
# 校验
tcb cloudrun list --service-name zhhs01-agent --env-id zhhs-agent-2608-d1fs32gddb84cdea
```

- **密钥**：`AIFLOWY_API_KEY` 等在 CloudBase 控制台「云托管 → 服务配置 → 环境变量」注入，不进仓库。
- **灰度/回滚**：`tcb cloudrun deploy --traffic`（新版本 0% 流量）→ `tcb cloudrun traffic set --version-weights <new>=10,<stable>=90` → 观察 → 100%；回滚直接把稳定版本设回 100%。
- **CORS 已收紧**（代码内置，`src/index.js`）：`Access-Control-Allow-Origin` 从 `*` 改为白名单——放行 Web 托管域名（`*.app.tcloudbase.com` / `*.tcloudbaseapp.com`）与 `Origin:null`（Electron `file://` 桌面端），未知来源不设 ACAO 由浏览器拦截。可用环境变量 `ALLOWED_ORIGINS`（逗号分隔）覆盖默认白名单。

### 5.3 云函数 `zhipu-proxy`（HTTP Function）

> ⚠️ **cwd 约束**：云函数必须在**仓库根目录**执行（根 `cloudbaserc.json` 声明了 `functionRoot: "backend/functions"`）。

```bash
cd <仓库根>                       # 根目录 cloudbaserc.json 声明了 functionRoot
# 部署（HTTP 函数必须带 --httpFn，且目录含可执行 scf_bootstrap + 监听 9000）
tcb fn deploy zhipu-proxy --httpFn --force --env-id zhhs-agent-2608-d1fs32gddb84cdea
# 确保 ZHIPU_API_KEY / APP_TOKEN 已注入函数环境变量（控制台 / tcb fn config update）
tcb fn detail zhipu-proxy --env-id zhhs-agent-2608-d1fs32gddb84cdea
# 校验
tcb fn invoke zhipu-proxy --env-id zhhs-agent-2608-d1fs32gddb84cdea
```

> HTTP 函数走网关默认域名 `*.app.tcloudbase.com`，前端经 `/zhipu-proxy` 可调（网关已放开 CORS，函数内**不要**再写 CORS 头，否则重复导致 `Failed to fetch`）。

> ⚠️ **envVariables 全量覆盖陷阱（已踩坑）**：`tcb fn deploy` 会用 `cloudbaserc.json` 的 `envVariables` **整体替换**函数环境变量。`ZHIPU_API_KEY` 因不写进仓库（public），部署后会被清空 → 平台默认 zhipu 对话报 `ZHIPU_API_KEY not configured`。**每次 `fn deploy` 后必须核对**（`deploy.sh fn` 已内置核对告警）：缺失时从智谱开放平台复制 Key → 控制台「云函数 → zhipu-proxy → 环境变量」重新填入。BYOK 自定义大模型（用户自带 Key）不受此影响。

**轻量鉴权（防白嫖）**：`zhipu-proxy` 已加 `APP_TOKEN` 校验——前端把 `appToken` 放进**请求体**（不走自定义请求头，避免触发 CORS 预检），函数比对云端环境变量 `APP_TOKEN`：未配置返回 `503`、不一致返回 `403`。`APP_TOKEN` 定位是「防随机扫描/爬虫」级保护，**不是**强鉴权（前端代码公开，令牌可被反编译看到）；若需强一致鉴权，应在函数端校验 CloudBase 登录态（需引入 `@cloudbase/node-sdk` 显式凭证）。`APP_TOKEN` 在根 `cloudbaserc.json` 与前端 `index.html`（含桌面端 renderer 副本）两处保持一致，轮换时三端同步改。

---

## 6. 统一部署编排 `scripts/deploy.sh`

一条命令发布全部，或直接指定单个模块；每个步骤失败即中断；部署后自动冒烟校验。

```bash
#!/usr/bin/env bash
# 用法：
#   ./scripts/deploy.sh              # 全量发布（web + agent + fn）
#   ./scripts/deploy.sh web          # 只发静态托管
#   ./scripts/deploy.sh agent        # 只发云托管
#   ./scripts/deploy.sh fn           # 只发云函数
set -euo pipefail

ENV_ID="${CB_ENV_ID:-zhhs-agent-2608-d1fs32gddb84cdea}"
WEB_URL="https://${ENV_ID}.tcloudbaseapp.com/"
AGENT_URL="${AGENT_URL:-https://zhhs01-agent-295034-9-1304202737.sh.run.tcloudbase.com}"
FN_URL="${FN_URL:-https://zhhs-agent-2608-d1fs32gddb84cdea-1304202737.ap-shanghai.app.tcloudbase.com/zhipu-proxy}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-all}"

echo "==> target=$TARGET  env=$ENV_ID"

deploy_web() {
  echo "==> [1/3] 静态托管 web"
  local tag
  tag="$(date +%Y-%m-%d-%H%M)"
  # BUILD_TAG 自动递增：打破浏览器/HTML 缓存，发布留痕（改动会落到 index.html，记得提交）
  sed -i "s/const BUILD_TAG = \"[^\"]*\"/const BUILD_TAG = \"${tag}\"/" "$ROOT/web/index.html"
  echo "    BUILD_TAG -> $tag"
  # renderer 同步检查：忽略 BUILD_TAG 行，其余内容应与桌面端副本一致（不一致需重新打包桌面端）
  if ! diff <(grep -v "BUILD_TAG" "$ROOT/web/index.html") \
            <(grep -v "BUILD_TAG" "$ROOT/desktop/renderer/index.html") >/dev/null 2>&1; then
    echo "    ⚠️ WARN: 桌面端 renderer/index.html 与 web 不一致，请同步后重新打包桌面端"
  fi
  ( cd "$ROOT/web" && tcb hosting deploy ./ --env-id "$ENV_ID" --yes )
  echo "    访问: $WEB_URL"
  echo "    冒烟: HTTP $(curl -s -o /dev/null -w '%{http_code}' "$WEB_URL" || echo fail)"
}

deploy_agent() {
  echo "==> [2/3] 云托管 backend/cloudrun (CloudRun)"
  ( cd "$ROOT/backend/cloudrun" && tcb cloudrun deploy --service-name zhhs01-agent --env-id "$ENV_ID" --force )
  echo "    冒烟: HTTP $(curl -s -o /dev/null -w '%{http_code}' "$AGENT_URL/healthz" || echo fail)"
}

deploy_fn() {
  echo "==> [3/3] 云函数 zhipu-proxy (HTTP)"
  ( cd "$ROOT" && tcb fn deploy zhipu-proxy --httpFn --force --env-id "$ENV_ID" )
  echo "    冒烟: HTTP $(curl -s -o /dev/null -w '%{http_code}' "$FN_URL/healthz" || echo fail)"
}

case "$TARGET" in
  web)   deploy_web ;;
  agent) deploy_agent ;;
  fn)    deploy_fn ;;
  all)
    deploy_web
    deploy_agent
    deploy_fn
    ;;
  *) echo "未知目标: $TARGET (可选 web|agent|fn|all)"; exit 2 ;;
esac

echo "==> 部署完成。静态托管 CDN 有 5-10 分钟缓存，旧资源可能短暂残留；BUILD_TAG 改动请随本次发布一起提交。"
```

> 给予执行权限：`chmod +x scripts/deploy.sh`。

### 6.1 CI/CD（GitHub Actions，`.github/workflows/deploy.yml`）

push 到 `main` 且改动涉及 `web/**` / `backend/functions/**` / `cloudbaserc.json` / `scripts/**` / `.github/workflows/**` 时，自动执行**静态托管 + 云函数**两步（调用 `deploy.sh web` 与 `deploy.sh fn`）。云托管涉及 Docker 构建与密钥，保留手动发布。

首次配置（一次性）：
1. CloudBase 控制台「环境设置 → API Key」创建**环境级 API Key**（权限仅限该环境，优于主账号密钥）。
2. 仓库 `Settings → Secrets and variables → Actions` 添加 `CLOUDBASE_API_KEY = <上一步的 Key>`。

CI 内登录方式：`tcb login --cloudbase-api-key $CLOUDBASE_API_KEY -e <envId>`（见 cloudbase-cli `core.md`）。CI 中 `BUILD_TAG` 递增只影响 runner 内产物，不回写仓库，无需自动 commit。

---

## 7. 密钥与环境变量管理

| 密钥 | 归属 | 注入方式 | 是否在仓库 |
|------|------|----------|------------|
| `ZHIPU_API_KEY` | 云函数 `zhipu-proxy` | 控制台函数环境变量 / `tcb secrets set` | ❌ 绝不 |
| `APP_TOKEN` | 云函数 + 前端（web 与桌面副本） | `cloudbaserc.json` 与 `index.html` 两处保持一致（防扫描级，非强鉴权） | ✅ 见 5.3 |
| `AIFLOWY_API_KEY` / `AIFLOWY_BOT_ID` / `AIFLOWY_ENDPOINT` | 云托管 `zhhs01-agent`（backend/cloudrun） | 控制台云托管服务环境变量 | ❌ 绝不 |
| `ALLOWED_ORIGINS` | 云托管（可选） | 环境变量覆盖默认 CORS 白名单 | 可选 |
| `CB_ACCESS_KEY` | 前端（匿名 publishable） | 前端硬编码（公开密钥，可接受） | ✅ 仅 publishable |
| `ZHIPU_ENDPOINT` | 云函数 | `cloudbaserc.json` 非机密默认值 | ✅ |

规则：任何 `API_KEY` / `SECRET` / `BOT_ID` 只存在云端环境变量，前端只放匿名 publishable key。仓库为 public，提交前用 `git diff` 复查无密钥泄露。

---

## 8. 发布流程、缓存与回滚

1. **BUILD_TAG 缓存破冰**：`web/index.html` 中 `cloudbase.bundle.js` 等资源引用带 `?v=<BUILD_TAG>`。`deploy.sh` 的 `deploy_web` 已自动递增 `BUILD_TAG`（时间戳），改动落到 `index.html`，发布后随本次提交留痕。桌面端打包前需将新 `BUILD_TAG` 同步到 `renderer/index.html`。
2. **静态托管 CDN/浏览器缓存窗口（实测）**：`index.html` 响应头 `cache-control: public, max-age=300, s-maxage=600`——**浏览器缓存 5 分钟、CDN 缓存 10 分钟**。发版后用户 5 分钟内打开仍可能是旧版，误报"没改"。验证线上是否最新：`curl -H "Cache-Control: no-cache" <url>` 对比本地；用户侧强制刷新（Ctrl+Shift+R / 无痕）。**根治（控制台操作）**：静态托管 → 缓存配置 → 对 `index.html` / `*.html` 设 TTL=0（HTML 不缓存），静态资源（js/css/woff2/png）设长缓存（如 604800s），靠 BUILD_TAG 破缓存。
3. **云托管回滚**：见 5.2 的 `traffic set` 把稳定版本权重设回 100%；或 `tcb cloudrun deploy` 重新部署历史镜像。
4. **云函数回滚**：`tcb fn publish-version` 后保留历史版本，必要时重新 `tcb fn code update` 旧代码；函数类型/运行时创建后不可改，回滚用代码覆盖而非变更类型。

---

## 9. 桌面端交付（独立，不走托管）

`desktop/` 是 Electron 工程，渲染进程 `renderer/index.html` 与 `web/index.html` 为**同源同步副本**（当前已由 Web 版覆盖一致）。打包流程独立于 CloudBase：

```bash
cd desktop
npm install
npm run pack   # 产出 exe（约 95MB）
```

- exe 上传到静态托管根目录供「下载 Windows 版」按钮命中（已验证可用）。
- **同步机制**：`deploy.sh web` 会忽略 `BUILD_TAG` 行 diff 两份 `index.html`，不一致时告警；日常保持同步做法是 `cp web/index.html desktop/renderer/index.html` 后重新打包。

---

## 10. 风险与待办

- [x] 根 `cloudbaserc.json` + `scripts/deploy.sh`（已落地）。
- [x] `BUILD_TAG` 发布脚本自动递增（已落地）。
- [x] 生产收紧 CORS（agent 白名单 + `Origin:null` 桌面端放行，已落地）。
- [x] GitHub Actions CI（已建，需配 `CLOUDBASE_API_KEY` Secret 后生效）。
- [x] 删除冗余 `_online_index.html`、同步桌面端 renderer（已落地）。
- [ ] 确认 `zhipu-proxy` 的 `ZHIPU_API_KEY` 已在云端环境变量配置（部署后 `tcb fn detail` 核对）。
- [ ] 静态托管 SPA 路由（`indexDocument`/`errorDocument`）确认已设。
- [ ] 弱密码测试账号 `wangxiaoting` 生产前清理。
- [ ] CORS 收紧后回归：Web 端（托管域名）与桌面端（file://）各跑一轮对话验证。
- [ ] 若对外正式上线，建议新增 dev/prod 两套环境隔离。
