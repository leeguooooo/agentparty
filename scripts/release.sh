#!/usr/bin/env bash
# AgentParty release：bump → 门禁 → tag → 推送 → 盯 CI（flaky 自动重推一次）→ 装机验证。
# 用法: scripts/release.sh 0.2.70
# 固化自 v0.2.65–v0.2.69 的五次手工发版；CI 满载偶发超时（issue #48）由 RETRY 兜底。
set -euo pipefail

VER="${1:?用法: scripts/release.sh <version 如 0.2.70>}"
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "版本号格式错: $VER"; exit 1; }
TAG="v$VER"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 0) 前置检查
[[ -z "$(git status --porcelain)" ]] || { echo "工作树不干净，先提交或 stash:"; git status --short; exit 1; }
git rev-parse "$TAG" >/dev/null 2>&1 && { echo "tag $TAG 已存在"; exit 1; }
CUR=$(python3 -c "import json;print(json.load(open('cli/package.json'))['version'])")
echo "== $CUR → $VER =="

# 1) bump + 本地完整门禁（与 CI 同一 bun run check；先在本地挂掉比在 CI 挂便宜）
python3 - "$VER" <<'PY'
import json,sys
p='cli/package.json'; d=json.load(open(p)); d['version']=sys.argv[1]
open(p,'w').write(json.dumps(d,indent=2,ensure_ascii=False)+"\n")
PY
echo "== 本地门禁 bun run check =="
if ! bun run check; then
  echo "!! 门禁失败。若是 worker 超时（issue #48 flaky），隔离跑该 spec 确认后可 SKIP_LOCAL_CHECK=1 重来"
  [[ "${SKIP_LOCAL_CHECK:-}" == "1" ]] || { git checkout cli/package.json; exit 1; }
fi

# 2) 提交 + tag + 推送
git add cli/package.json
git commit -m "chore(release): $TAG" -m "Claude-Session: ${CLAUDE_SESSION_URL:-scripts/release.sh}"
git tag "$TAG"
git push origin main
git push origin "$TAG"

# 3) 盯 tag 的 CI；失败一次 → 若是 full check 超时类 flaky，把 tag 移到 HEAD 重推一次
watch_tag_run() {
  sleep 8
  local id
  id=$(gh run list --workflow=release.yml --limit 8 --json databaseId,headBranch \
    | python3 -c "import sys,json; r=[x for x in json.load(sys.stdin) if x.get('headBranch')=='$TAG']; print(r[0]['databaseId'] if r else '')")
  [[ -n "$id" ]] || { echo "找不到 $TAG 的 run"; return 2; }
  echo "== watch run $id =="
  gh run watch "$id" --exit-status >/dev/null && return 0 || return 1
}
if ! watch_tag_run; then
  echo "!! CI 失败，重推 tag 兜底一次（flaky 超时场景，见 v0.2.67）"
  git push --delete origin "$TAG" || true
  git tag -f "$TAG"
  git push origin "$TAG"
  watch_tag_run || { echo "!! 重推后仍失败——不是 flaky，去看日志: gh run view --log-failed"; exit 1; }
fi

# 4) 确认 release 资产 + 装机验证
echo "== release 资产 =="
gh release view "$TAG" --json assets \
  | python3 -c "import sys,json; a=[x['name'] for x in json.load(sys.stdin)['assets'] if x['name'].endswith('.tar.gz')]; assert len(a)>=5, f'二进制不足: {a}'; print(len(a),'binaries ok')"
echo "== 装机 =="
curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh
INSTALLED=$(party --version)
[[ "$INSTALLED" == "$VER" ]] || { echo "!! 装机版本 $INSTALLED ≠ $VER"; exit 1; }
echo "✅ $TAG 发布完成，本机 party=$INSTALLED"
