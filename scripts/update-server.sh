#!/usr/bin/env bash
# LearnHarness Self-Hosted Linux x64 Server Updater
#
# Usage:
#   sudo bash /opt/learnharness/src/scripts/update-server.sh            # update to latest GitHub release
#   sudo bash /opt/learnharness/src/scripts/update-server.sh v0.7.3     # update to a specific release tag
#
# Safely downloads the prebuilt standalone bundle, verifies its structure,
# swaps /opt/learnharness/standalone atomically, restarts learnharness.service,
# verifies /api/health, and automatically rolls back on failure.
# Never modifies /var/lib/learnharness/data or /etc/learnharness.

set -euo pipefail

REPO="${LH_GITHUB_REPO:-lukemxlr/learnharness}"
INSTALL_ROOT="${LH_INSTALL_ROOT:-/opt/learnharness}"
STANDALONE_DIR="${INSTALL_ROOT}/standalone"
STAGE_DIR="${INSTALL_ROOT}/standalone.new"
PREV_DIR="${INSTALL_ROOT}/standalone.prev"
SERVICE_NAME="${LH_SERVICE_NAME:-learnharness}"
SERVICE_USER="${LH_SERVICE_USER:-learnharness}"
HEALTH_URL="${LH_HEALTH_URL:-http://127.0.0.1:3000/api/health}"
REQUESTED_TAG="${1:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (e.g. sudo bash $0 ${REQUESTED_TAG})." >&2
  exit 1
fi

for cmd in curl tar node systemctl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 1
  fi
done

CURRENT_VERSION="unknown"
if [ -f "${STANDALONE_DIR}/package.json" ]; then
  CURRENT_VERSION="$(node -e "console.log(require('${STANDALONE_DIR}/package.json').version || 'unknown')" 2>/dev/null || echo unknown)"
fi

if [ -n "$REQUESTED_TAG" ]; then
  TAG="v${REQUESTED_TAG#v}"
else
  echo "Checking latest LearnHarness release from github.com/${REPO}..."
  TAG="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/${REPO}/releases/latest" \
    | node -e "const d = JSON.parse(require('fs').readFileSync(0,'utf8')); if (!d.tag_name) process.exit(1); console.log(d.tag_name);")"
fi

VERSION="${TAG#v}"
TARBALL_NAME="LearnHarness-${VERSION}-server-linux-x64.tar.gz"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${TARBALL_NAME}"
TMP_TAR="$(mktemp "/tmp/learnharness-${VERSION}-XXXXXX.tar.gz")"
TMP_HEALTH="$(mktemp "/tmp/learnharness-health-XXXXXX.json")"

cleanup() {
  rm -f "$TMP_TAR" "$TMP_HEALTH"
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

echo "Current server version: ${CURRENT_VERSION}"
echo "Target release:         ${TAG} (${TARBALL_NAME})"

if [ "$CURRENT_VERSION" = "$VERSION" ] && [ "${LH_FORCE_UPDATE:-0}" != "1" ]; then
  echo "Server is already on version ${VERSION}. Set LH_FORCE_UPDATE=1 to reinstall."
  exit 0
fi

echo "Downloading ${DOWNLOAD_URL}..."
curl -fL --retry 3 -o "$TMP_TAR" "$DOWNLOAD_URL"

echo "Extracting and verifying bundle..."
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
tar -xzf "$TMP_TAR" -C "$STAGE_DIR"

if [ ! -f "${STAGE_DIR}/server.js" ]; then
  FOUND_SERVER="$(find "$STAGE_DIR" -maxdepth 2 -name server.js -print -quit)"
  if [ -z "$FOUND_SERVER" ]; then
    echo "ERROR: Downloaded archive does not contain server.js. Aborting without changes." >&2
    exit 1
  fi
  SUBDIR="$(dirname "$FOUND_SERVER")"
  mv "$SUBDIR" "${STAGE_DIR}.unwrapped"
  rm -rf "$STAGE_DIR"
  mv "${STAGE_DIR}.unwrapped" "$STAGE_DIR"
fi

STAGED_VERSION="$(node -e "console.log(require('${STAGE_DIR}/package.json').version || '')" 2>/dev/null || true)"
if [ "$STAGED_VERSION" != "$VERSION" ]; then
  echo "ERROR: Archive package.json version (${STAGED_VERSION}) does not match target (${VERSION}). Aborting." >&2
  exit 1
fi

chown -R "${SERVICE_USER}:${SERVICE_USER}" "$STAGE_DIR"

rollback() {
  echo "Health check failed — rolling back to previous version (${CURRENT_VERSION})..." >&2
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  rm -rf "$STANDALONE_DIR"
  if [ -d "$PREV_DIR" ]; then
    mv "$PREV_DIR" "$STANDALONE_DIR"
  fi
  systemctl start "$SERVICE_NAME" || true
  echo "Rollback complete. Inspect logs with: journalctl -u ${SERVICE_NAME} -n 80 --no-pager" >&2
  exit 1
}

echo "Swapping ${STANDALONE_DIR} atomically and restarting ${SERVICE_NAME}..."
systemctl stop "$SERVICE_NAME"
rm -rf "$PREV_DIR"
if [ -d "$STANDALONE_DIR" ]; then
  mv "$STANDALONE_DIR" "$PREV_DIR"
fi
mv "$STAGE_DIR" "$STANDALONE_DIR"
systemctl start "$SERVICE_NAME"

echo "Waiting for ${HEALTH_URL}..."
HEALTHY=0
for _ in $(seq 1 25); do
  if curl -fsS "$HEALTH_URL" >"$TMP_HEALTH" 2>/dev/null; then
    if node -e "const d = JSON.parse(require('fs').readFileSync('${TMP_HEALTH}','utf8')); process.exit(d && d.ok === true ? 0 : 1)" 2>/dev/null; then
      HEALTHY=1
      break
    fi
  fi
  sleep 1
done

if [ "$HEALTHY" -ne 1 ] || ! systemctl is-active --quiet "$SERVICE_NAME"; then
  rollback
fi

rm -rf "$PREV_DIR"

if [ -d "${INSTALL_ROOT}/src/.git" ]; then
  git -C "${INSTALL_ROOT}/src" fetch --quiet origin main 2>/dev/null || true
  git -C "${INSTALL_ROOT}/src" pull --ff-only --quiet origin main 2>/dev/null || true
fi

echo "LearnHarness server updated cleanly: ${CURRENT_VERSION} -> ${VERSION} (health OK)."
