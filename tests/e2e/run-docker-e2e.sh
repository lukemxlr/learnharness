#!/usr/bin/env bash
set -euo pipefail

# Containerized E2E entrypoint for LearnHarness (runs inside learnharness-e2e:local).
# Never modifies /repo (mounted :ro); all builds & temporary state stay in /work and /tmp.

REPO_DIR="${LH_REPO_DIR:-/repo}"
WORK_DIR="${LH_E2E_WORK_DIR:-/work}"
ARTIFACTS_DIR="${LH_E2E_ARTIFACTS_DIR:-/artifacts}"
NODE26_BIN="${LH_NODE26_BIN:-/opt/node26/bin/node}"
E2E_MODULES="/opt/e2e/node_modules"

mkdir -p "$WORK_DIR" "$ARTIFACTS_DIR" /tmp/lh-e2e-home /tmp/lh-e2e-tmp
if [[ -d "$ARTIFACTS_DIR" && -w "$ARTIFACTS_DIR" ]]; then
  mkdir -p "$ARTIFACTS_DIR/test-results"
fi
export HOME="/tmp/lh-e2e-home"
export TMPDIR="/tmp/lh-e2e-tmp"
export LH_IGNORE_ENV_KEYS=1
export NEXT_TELEMETRY_DISABLED=1
export LH_E2E_ARTIFACTS_DIR="$ARTIFACTS_DIR"
export LH_NODE26_BIN="$NODE26_BIN"

BUILD_APP=0
RUN_TIER1=0
RUN_TIER2=0
RUN_TIER3=0
RUN_TIER4=0
PW_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --build-app)
      BUILD_APP=1
      ;;
    --list)
      PW_ARGS+=(--list)
      ;;
    --selfcheck)
      PW_ARGS+=(specs/harness-selfcheck.spec.mjs)
      ;;
    --tier1)
      RUN_TIER1=1
      ;;
    --tier2)
      RUN_TIER2=1
      ;;
    --tier3)
      RUN_TIER3=1
      ;;
    --tier4)
      RUN_TIER4=1
      ;;
    --all)
      RUN_TIER1=0
      RUN_TIER2=0
      RUN_TIER3=0
      RUN_TIER4=0
      PW_ARGS=()
      ;;
    *)
      PW_ARGS+=("$arg")
      ;;
  esac
done

# Optional full standalone app build inside container overlayfs/volume (/work/app).
if [[ "$BUILD_APP" -eq 1 ]]; then
  APP_BUILD_DIR="$WORK_DIR/app"
  echo "[e2e] Syncing $REPO_DIR -> $APP_BUILD_DIR for Node 26 standalone build..."
  mkdir -p "$APP_BUILD_DIR"
  LOCK_HASH="$(cat "$REPO_DIR/package-lock.json" "$REPO_DIR"/plugins/*/package-lock.json "$REPO_DIR/scripts/build-plugin-types.mjs" 2>/dev/null | sha256sum | awk '{print $1}')"
  PREV_HASH=""
  if [[ -f "$APP_BUILD_DIR/.lh-deps-hash" ]]; then
    PREV_HASH="$(cat "$APP_BUILD_DIR/.lh-deps-hash")"
  fi
  if [[ "$LOCK_HASH" == "$PREV_HASH" && -d "$APP_BUILD_DIR/node_modules" && -d "$APP_BUILD_DIR/plugins/drawing-pad/node_modules" ]]; then
    # Keep cached root and plugin node_modules; refresh all repo sources cleanly.
    find "$APP_BUILD_DIR" -mindepth 1 -maxdepth 1 ! -name "node_modules" ! -name "plugins" ! -name ".lh-deps-hash" -exec rm -rf {} +
    if [[ -d "$APP_BUILD_DIR/plugins" ]]; then
      for pdir in "$APP_BUILD_DIR/plugins"/*; do
        [[ -d "$pdir" ]] || continue
        find "$pdir" -mindepth 1 -maxdepth 1 ! -name "node_modules" ! -name ".sdk" -exec rm -rf {} +
      done
    fi
  else
    find "$APP_BUILD_DIR" -mindepth 1 -maxdepth 1 ! -name "node_modules" -exec rm -rf {} +
  fi
  tar -C "$REPO_DIR" \
    --exclude="./.git" \
    --exclude="node_modules" \
    --exclude="./.next" \
    --exclude="./data" \
    --exclude="./dist" \
    --exclude="./auth.json" \
    --exclude="./user-auth.json*" \
    --exclude="./*-credentials.json*" \
    --exclude="./.env*" \
    -cf - . | tar -C "$APP_BUILD_DIR" -xf -

  echo "[e2e] Building standalone server under Node 26..."
  (
    cd "$APP_BUILD_DIR"
    export PATH="/opt/node26/bin:$PATH"
    if [[ "$LOCK_HASH" != "$PREV_HASH" || ! -d "$APP_BUILD_DIR/node_modules" || ! -d "$APP_BUILD_DIR/plugins/drawing-pad/node_modules" ]]; then
      echo "[e2e] Installing app & plugin dependencies (lockfile changed or cold cache)..."
      npm ci --no-audit --no-fund
      npm run plugins:setup
      printf '%s' "$LOCK_HASH" > "$APP_BUILD_DIR/.lh-deps-hash"
    else
      echo "[e2e] Reusing cached Node 26 dependencies (lockfile hash matched)."
    fi
    npm run build
    "$NODE26_BIN" scripts/build-server.mjs
  )
  export LH_REPO_DIR="$APP_BUILD_DIR"
  export LH_STANDALONE_DIR="$APP_BUILD_DIR/.next/standalone"
else
  export LH_REPO_DIR="$REPO_DIR"
fi

# Copy tiny E2E .mjs suite into container-local overlayfs (/tmp/lh-e2e-runner)
# and link /opt/e2e/node_modules there so Node ESM resolves @playwright/test
# without creating node_modules inside the read-only /repo bind mount.
E2E_RUN_DIR="/tmp/lh-e2e-runner"
rm -rf "$E2E_RUN_DIR"
mkdir -p "$E2E_RUN_DIR"
tar -C "$REPO_DIR/tests/e2e" --exclude="node_modules" --exclude="test-results" --exclude="playwright-report" -cf - . | tar -C "$E2E_RUN_DIR" -xf -
ln -s "$E2E_MODULES" "$E2E_RUN_DIR/node_modules"

cd "$E2E_RUN_DIR"
add_tier_specs() {
  local tier_name="$1"
  local pattern="$2"
  shopt -s nullglob
  local matched=($pattern)
  shopt -u nullglob
  if [[ "${#matched[@]}" -eq 0 ]]; then
    echo "[e2e] ERROR: No ${tier_name} specs found in $E2E_RUN_DIR/specs" >&2
    exit 1
  fi
  PW_ARGS+=("${matched[@]}")
}
if [[ "$RUN_TIER1" -eq 1 ]]; then
  add_tier_specs "tier1" "specs/tier1-*.spec.mjs"
fi
if [[ "$RUN_TIER2" -eq 1 ]]; then
  add_tier_specs "tier2" "specs/tier2-*.spec.mjs"
fi
if [[ "$RUN_TIER3" -eq 1 ]]; then
  add_tier_specs "tier3" "specs/tier3-*.spec.mjs"
fi
if [[ "$RUN_TIER4" -eq 1 ]]; then
  add_tier_specs "tier4" "specs/tier4-*.spec.mjs"
fi
echo "[e2e] Node (Playwright): $(node -v) | Node (Server): $($NODE26_BIN -v) | Repo: $LH_REPO_DIR"
exec /opt/e2e/node_modules/.bin/playwright test "${PW_ARGS[@]}"
