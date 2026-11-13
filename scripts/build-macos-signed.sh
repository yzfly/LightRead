#!/usr/bin/env bash
# 在 jiangshuMac 上打 macOS 正式包: Developer ID 签名 + Apple 公证 + 装订票据 (应用与 DMG 都装订)。
# 没有整包签名的包, 浏览器下载后在 Apple 芯片 Mac 上会报「已损坏」且无法放行 (issue #20)。
#
#   scripts/build-macos-signed.sh <输出目录>
#
# 必须在 jiangshuMac 桌面会话启动的 tmux 里运行 (ssh 直接执行拿不到钥匙串里的私钥, codesign 报
# errSecInternalComponent): ssh jiangshumac 'tmux new-session -d -s lr-mac "…/scripts/build-macos-signed.sh ~/out"'
# 签名身份与公证 API 密钥取自环境变量 (该机 ~/.zshrc 已配置), 值不入仓库:
#   APPLE_SIGNING_IDENTITY  APPLE_API_ISSUER  APPLE_API_KEY  APPLE_API_KEY_PATH
# 产物: LightRead_<版本>_aarch64.dmg 与 LightRead_<版本>_x64.dmg, 逐个校验后才放进输出目录。
set -euo pipefail

OUT=${1:?用法: build-macos-signed.sh <输出目录>}
TEAM_ID=${APPLE_TEAM_ID_EXPECTED:-3HNKBKJ59V}
: "${APPLE_SIGNING_IDENTITY:?缺少 APPLE_SIGNING_IDENTITY}" "${APPLE_API_ISSUER:?缺少 APPLE_API_ISSUER}"
: "${APPLE_API_KEY:?缺少 APPLE_API_KEY}" "${APPLE_API_KEY_PATH:?缺少 APPLE_API_KEY_PATH}"
[[ $APPLE_SIGNING_IDENTITY == "Developer ID Application:"* ]] || { echo "签名身份必须是 Developer ID Application" >&2; exit 1; }

cd "$(dirname "$0")/.."
VERSION=$(node -p 'require("./src-tauri/tauri.conf.json").version')
mkdir -p "$OUT"
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$PWD/src-tauri/target}

# 应用已由 tauri build 签名、公证、装订; 这里核对结果, 不通过就不出包。
# 先把命令输出收进变量再匹配: 直接接 grep -q 时, grep 提前退出会让上游收到 SIGPIPE, pipefail 下整个脚本以 141 退出。
has() { local out; out=$("${@:2}" 2>&1) || true; printf '%s\n' "$out" >&2; [[ $out == *"$1"* ]]; }

check_app() {
  local app=$1 arch=$2
  codesign --verify --deep --strict --verbose=2 "$app"
  has "TeamIdentifier=$TEAM_ID" codesign -dvv "$app"
  has '(runtime)' codesign -dvv "$app"
  xcrun stapler validate "$app"
  has 'source=Notarized Developer ID' spctl -a -t exec -vv "$app"
  [[ $(lipo -archs "$app/Contents/MacOS/lightread") == "$arch" ]]
  [[ $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist") == "$VERSION" ]]
}

npm ci
for pair in aarch64-apple-darwin:aarch64:arm64 x86_64-apple-darwin:x64:x86_64; do
  IFS=: read -r target suffix arch <<<"$pair"
  rustup target add "$target" >/dev/null
  npx tauri build --target "$target"
  bundle="$CARGO_TARGET_DIR/$target/release/bundle"
  dmg="$bundle/dmg/LightRead_${VERSION}_${suffix}.dmg"
  check_app "$bundle/macos/LightRead.app" "$arch"

  # DMG 本身也公证并装订, 离线首次打开也不需要联网查票据。
  xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  has 'source=Notarized Developer ID' spctl -a -t open --context context:primary-signature -vv "$dmg"

  mnt=$(mktemp -d)
  hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" >/dev/null
  check_app "$mnt/LightRead.app" "$arch" || { hdiutil detach "$mnt" >/dev/null; exit 1; }
  hdiutil detach "$mnt" >/dev/null
  cp "$dmg" "$OUT/"
  echo "✓ $(basename "$dmg")"
done
(cd "$OUT" && shasum -a 256 LightRead_"${VERSION}"_*.dmg)
echo "MACOS_SIGNED_DONE $VERSION"
