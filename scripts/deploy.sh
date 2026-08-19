#!/usr/bin/env bash
# 中海言析智能工作台 —— 统一部署编排
# 用法：
#   ./scripts/deploy.sh              # 全量发布（web + agent + fn）
#   ./scripts/deploy.sh web          # 只发静态托管
#   ./scripts/deploy.sh agent        # 只发云托管
#   ./scripts/deploy.sh fn           # 只发云函数
set -euo pipefail

ENV_ID="${CB_ENV_ID:-zhhs-agent-2608-d1fs32gddb84cdea}"
# ⚠️ 静态托管默认域名必须带账号 appId 后缀（-1304202737），否则 curl 会拿到 418 误报部署失败
WEB_URL="https://${ENV_ID}-1304202737.tcloudbaseapp.com/"
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
  echo "    冒烟: HTTP $(curl -s -m 20 -w '%{http_code}' -o /tmp/_web_smoke.txt "$WEB_URL" 2>/dev/null || echo fail)"
}

deploy_agent() {
  echo "==> [2/3] 云托管 backend/cloudrun (CloudRun)"
  ( cd "$ROOT/backend/cloudrun" && tcb cloudrun deploy --service-name zhhs01-agent --env-id "$ENV_ID" --force )
  echo "    冒烟: HTTP $(curl -s -m 15 -w '%{http_code}' -o /tmp/_agent_smoke.txt "$AGENT_URL/healthz" 2>/dev/null || echo fail)"
}

deploy_fn() {
  echo "==> [3/3] 云函数 zhipu-proxy (HTTP)"
  ( cd "$ROOT" && tcb fn deploy zhipu-proxy --httpFn --force --env-id "$ENV_ID" )
  # ⚠️ fn deploy 会用 cloudbaserc.json 的 envVariables 全量覆盖函数环境变量，
  #    密钥类变量（ZHIPU_API_KEY）不写进仓库、会在此处被清空 → 部署后必须核对。
  local envline
  envline="$(tcb fn detail zhipu-proxy --env-id "$ENV_ID" 2>/dev/null | grep "Environment variables" || true)"
  if echo "$envline" | grep -q "ZHIPU_API_KEY="; then
    echo "    ✅ 函数环境变量含 ZHIPU_API_KEY"
  else
    echo "    ⚠️⚠️ 函数环境变量缺 ZHIPU_API_KEY —— 平台默认 zhipu 对话将不可用！"
    echo "      恢复：智谱开放平台复制 Key → CloudBase 控制台「云函数 → zhipu-proxy → 环境变量」填 ZHIPU_API_KEY"
    echo "      （BYOK 自定义大模型不受影响，用户自带 Key 无需服务端密钥）"
  fi
  echo "    冒烟: HTTP $(curl -s -m 15 -w '%{http_code}' -o /tmp/_fn_smoke.txt "$FN_URL/healthz" 2>/dev/null || echo fail)"
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
