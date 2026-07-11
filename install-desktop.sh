#!/usr/bin/env sh
# agentparty install-desktop.sh — macOS production 桌面端安装器（#248）
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install-desktop.sh | sh
# 环境变量:
#   AGENTPARTY_VERSION       要装的版本，默认 latest（解析 releases/latest 重定向）。形如 0.2.90 或 v0.2.90。
#   AGENTPARTY_MIRROR        下载 base url，默认 github releases。GFW/内网兜底。
#   AGENTPARTY_APP_DIR       安装目录，默认 /Applications（无写权时回落 $HOME/Applications）。
#
# 本脚本只安装 Developer ID 签名并通过 Apple 公证的 production 产物。
# preview、ad-hoc 签名、缺失公证票据或 Gatekeeper 拒绝的产物一律中止；不会移除 quarantine，
# 也不会在用户机器上重签名应用。
#
# 安全:
#   - 只装 macOS（Darwin）；其他平台直接拒绝。
#   - sha256 强校验 .dmg，并核对 CI 产出的签名状态元数据。
#   - DMG 和 staging app 都通过 Developer ID、Gatekeeper 与 stapler 验证后才替换旧版本。
#   - 替换失败时恢复原应用。
#   - 下载失败有上限退避重试，不静默循环。
set -eu

OWNER_REPO="leeguooooo/agentparty"
DEFAULT_MIRROR="https://github.com/${OWNER_REPO}/releases/download"
MIN_VERSION="0.2.90"   # 首个带一键安装的桌面版本；防降级到没有本脚本约定资产名的旧版
APP_NAME="AgentParty.app"

MIRROR="${AGENTPARTY_MIRROR:-$DEFAULT_MIRROR}"

log() { printf '%s\n' "agentparty-desktop: $*" >&2; }
die() { printf '%s\n' "agentparty-desktop: error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1; }

# ---- 平台探测: 仅 macOS ----
detect_asset() {
  os="$(uname -s)"
  [ "$os" = "Darwin" ] || die "本安装器仅支持 macOS（当前 $os）。CLI 用 install.sh。"
  arch="$(uname -m)"
  case "$arch" in
    arm64|aarch64) echo "darwin-arm64" ;;
    x86_64|amd64)  echo "darwin-x64" ;;
    *) die "unsupported arch: $arch" ;;
  esac
}

# ---- semver: 返回 0 当 $1 >= $2 ----
version_ge() {
  [ "$1" = "$2" ] && return 0
  lower="$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -n1)"
  [ "$lower" = "$2" ]
}

# ---- 解析版本（latest 走 releases/latest 重定向）----
resolve_version() {
  v="${AGENTPARTY_VERSION:-latest}"
  if [ "$v" = "latest" ]; then
    loc="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${OWNER_REPO}/releases/latest" 2>/dev/null || true)"
    v="${loc##*/}"
    [ -n "$v" ] || die "无法解析 latest 版本（网络？可设 AGENTPARTY_VERSION 指定）。"
  fi
  echo "${v#v}"
}

# ---- 带退避的下载（最多 3 次）----
fetch() {
  url="$1"; out="$2"
  i=1
  while [ "$i" -le 3 ]; do
    if curl -fsSL "$url" -o "$out"; then return 0; fi
    log "下载失败（第 $i 次）: $url"
    sleep "$((i * 3))"
    i="$((i + 1))"
  done
  return 1
}

main() {
  need curl || die "需要 curl。"
  need shasum || die "需要 shasum。"
  need hdiutil || die "需要 hdiutil（macOS 自带）。"
  need codesign || die "需要 codesign（装 Xcode Command Line Tools: xcode-select --install）。"
  need spctl || die "需要 spctl（macOS 自带）。"
  need xcrun || die "需要 xcrun（装 Xcode Command Line Tools: xcode-select --install）。"
  need plutil || die "需要 plutil（macOS 自带）。"

  asset="$(detect_asset)"
  version="$(resolve_version)"
  version_ge "$version" "$MIN_VERSION" || die "版本 $version 低于最低 $MIN_VERSION（防降级）。"
  log "安装 AgentParty Desktop v$version ($asset)"

  tag="v$version"
  base="$MIRROR/$tag"
  tmp="$(mktemp -d)"
  stage=""
  backup=""
  dst=""
  cleanup() {
    [ -n "${mnt:-}" ] && hdiutil detach "$mnt" -quiet 2>/dev/null || true
    [ -n "$stage" ] && rm -rf "$stage"
    if [ -n "$backup" ] && [ -d "$backup" ]; then
      if [ -n "$dst" ] && [ ! -e "$dst" ]; then mv "$backup" "$dst" 2>/dev/null || true; else rm -rf "$backup"; fi
    fi
    rm -rf "$tmp"
  }
  trap cleanup EXIT
  trap 'exit 130' HUP INT TERM

  dmg="agentparty-desktop-${asset}.dmg"
  status="agentparty-desktop-${asset}.signing-status.json"
  log "下载 $dmg …"
  fetch "$base/$dmg" "$tmp/$dmg" || die "下载 dmg 失败。"
  fetch "$base/$dmg.sha256" "$tmp/$dmg.sha256" || die "下载 sha256 失败。"
  fetch "$base/$status" "$tmp/$status" || die "下载桌面签名状态失败。"

  # sha256 强校验（.sha256 首字段是 hash）
  want="$(awk '{print $1}' "$tmp/$dmg.sha256")"
  got="$(shasum -a 256 "$tmp/$dmg" | awk '{print $1}')"
  [ -n "$want" ] || die "sha256 文件为空。"
  [ "$want" = "$got" ] || die "sha256 不匹配（期望 $want，实得 $got）。已中止，未安装。"
  log "sha256 校验通过。"

  notarized="$(plutil -extract notarized raw -o - "$tmp/$status" 2>/dev/null || true)"
  distribution="$(plutil -extract distribution raw -o - "$tmp/$status" 2>/dev/null || true)"
  auth="$(plutil -extract notarization_auth raw -o - "$tmp/$status" 2>/dev/null || true)"
  [ "$notarized" = "true" ] || die "该版本不是 Apple 公证产物，拒绝安装 preview。"
  [ "$distribution" = "production" ] || die "该版本未标记为 production，拒绝安装。"
  case "$auth" in apple-id|api-key) ;; *) die "签名状态缺少合法 notarization 认证记录。" ;; esac

  hdiutil verify "$tmp/$dmg" >/dev/null || die "DMG 结构校验失败。"
  xcrun stapler validate "$tmp/$dmg" >/dev/null 2>&1 || die "DMG 缺少有效 Apple 公证票据。"
  spctl --assess --type open --context context:primary-signature "$tmp/$dmg" >/dev/null 2>&1 || die "Gatekeeper 拒绝该 DMG。"

  # 挂载 dmg，取出 .app
  mnt="$(hdiutil attach "$tmp/$dmg" -nobrowse -readonly -mountrandom /tmp | awk '/\/Volumes\//{print $NF}' | tail -n1)"
  [ -n "$mnt" ] && [ -d "$mnt" ] || die "挂载 dmg 失败。"
  src="$(find "$mnt" -maxdepth 1 -name '*.app' -type d | head -n1)"
  [ -n "$src" ] || die "dmg 里找不到 .app。"

  # 安装目录（/Applications 无写权时回落 ~/Applications）
  appdir="${AGENTPARTY_APP_DIR:-/Applications}"
  if [ ! -w "$appdir" ] && [ "$appdir" = "/Applications" ]; then
    appdir="$HOME/Applications"
    mkdir -p "$appdir"
    log "/Applications 无写权限，改装到 $appdir"
  fi
  mkdir -p "$appdir" || die "无法创建安装目录 $appdir。"
  dst="$appdir/$APP_NAME"
  stage="$appdir/.${APP_NAME}.new.$$"
  backup="$appdir/.${APP_NAME}.backup.$$"
  rm -rf "$stage" "$backup"
  cp -R "$src" "$stage"

  info="$stage/Contents/Info.plist"
  installed_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info" 2>/dev/null || true)"
  [ "$installed_version" = "$version" ] || die "app 版本不匹配（期望 $version，实际 ${installed_version:-unknown}）。"
  [ -x "$stage/Contents/MacOS/party" ] || die "app 缺少可执行的内置 party sidecar。"
  bundled_version="$("$stage/Contents/MacOS/party" --version 2>/dev/null || true)"
  [ "$bundled_version" = "$version" ] || die "内置 party 版本不匹配。"
  codesign --verify --deep --strict --verbose=2 "$stage" >/dev/null 2>&1 || die "Developer ID 签名校验失败。"
  authority="$(codesign -dv --verbose=4 "$stage" 2>&1 || true)"
  printf '%s\n' "$authority" | grep -q '^Authority=Developer ID Application:' || die "app 不是 Developer ID Application 签名。"
  xcrun stapler validate "$stage" >/dev/null 2>&1 || die "app 缺少有效 Apple 公证票据。"
  spctl --assess --type execute "$stage" >/dev/null 2>&1 || die "Gatekeeper 拒绝该 app。"

  # 若目标正在运行，先退出
  if pgrep -f "$appdir/$APP_NAME/Contents/MacOS/" >/dev/null 2>&1; then
    log "检测到 AgentParty 正在运行，先退出它…"
    osascript -e 'quit app "AgentParty"' 2>/dev/null || true
    sleep 2
  fi

  log "安装到 $dst …"
  hdiutil detach "$mnt" -quiet 2>/dev/null || true
  mnt=""
  if [ -e "$dst" ]; then mv "$dst" "$backup" || die "无法备份现有应用。"; fi
  if ! mv "$stage" "$dst"; then
    [ -d "$backup" ] && mv "$backup" "$dst" 2>/dev/null || true
    die "替换应用失败，已尝试恢复旧版本。"
  fi
  stage=""
  rm -rf "$backup"
  backup=""

  log "✅ 已安装：$dst"
  log "启动：open \"$dst\"    或在 Launchpad/访达里双击。"
  log "Developer ID、Apple 公证与 Gatekeeper 校验均已通过。"
}

main "$@"
