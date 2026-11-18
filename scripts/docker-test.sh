#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
IMAGE_NAME="${LH_DOCKER_IMAGE:-learnharness-test:node26}"

build_image() {
	echo "[docker-test] Building image ${IMAGE_NAME} from docker/Dockerfile.test..."
	docker build -f "${REPO_ROOT}/docker/Dockerfile.test" -t "${IMAGE_NAME}" "${REPO_ROOT}"
}

ensure_image() {
	if ! docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
		build_image
	fi
}

run_in_container() {
	local cmd="$1"
	ensure_image
	docker run --rm --init \
		-e NEXT_TELEMETRY_DISABLED=1 \
		-e LH_DATA_DIR=/tmp/lh-test-data \
		-e LH_AUTH_FILE=/tmp/lh-test-auth/auth.json \
		-v "${REPO_ROOT}:/workspace" \
		-v lh_node_modules:/workspace/node_modules \
		-v lh_next:/workspace/.next \
		-v lh_core_plugins:/workspace/core-plugins \
		-v lh_plugin_coding_nm:/workspace/plugins/coding-questions/node_modules \
		-v lh_plugin_drawing_nm:/workspace/plugins/drawing-pad/node_modules \
		-v lh_plugin_flashcards_nm:/workspace/plugins/flashcards/node_modules \
		-v lh_plugin_rich_nm:/workspace/plugins/rich-code-blocks/node_modules \
		-v lh_plugin_ui_nm:/workspace/plugins/ui-showcase/node_modules \
		-w /workspace \
		"${IMAGE_NAME}" \
		bash -lc "mkdir -p /tmp/lh-test-data /tmp/lh-test-auth && ${cmd}"
}

CMD="${1:-baseline}"
shift || true

case "${CMD}" in
	build-image)
		build_image
		;;
	setup)
		run_in_container "npm ci && npm run plugins:setup"
		;;
	typecheck)
		run_in_container "npm run typecheck"
		;;
	test)
		if [ "$#" -gt 0 ]; then
			ARGS=""
			for arg in "$@"; do
				ARGS="${ARGS} $(printf '%q' "${arg}")"
			done
			run_in_container "NODE_ENV=test ./node_modules/.bin/tsx --test${ARGS}"
		else
			run_in_container "npm test"
		fi
		;;
	lint)
		run_in_container "npm run lint"
		;;
	build)
		run_in_container "npm run build"
		;;
	smoke)
		run_in_container "node scripts/smoke-provider-runtime.mjs && node scripts/build-server.mjs && node scripts/smoke-server.mjs --isolated"
		;;
	baseline)
		run_in_container "npm ci && npm run plugins:setup && npm run typecheck && npm test && npm run lint && npm run build && node scripts/smoke-provider-runtime.mjs && node scripts/build-server.mjs && node scripts/smoke-server.mjs --isolated"
		;;
	exec)
		if [ "$#" -eq 0 ]; then
			echo "Usage: $0 exec <command...>" >&2
			exit 2
		fi
		run_in_container "$*"
		;;
	shell)
		ensure_image
		docker run --rm --init -it \
			-e NEXT_TELEMETRY_DISABLED=1 \
			-e LH_DATA_DIR=/tmp/lh-test-data \
			-e LH_AUTH_FILE=/tmp/lh-test-auth/auth.json \
			-v "${REPO_ROOT}:/workspace" \
			-v lh_node_modules:/workspace/node_modules \
			-v lh_next:/workspace/.next \
			-v lh_core_plugins:/workspace/core-plugins \
			-v lh_plugin_coding_nm:/workspace/plugins/coding-questions/node_modules \
			-v lh_plugin_drawing_nm:/workspace/plugins/drawing-pad/node_modules \
			-v lh_plugin_flashcards_nm:/workspace/plugins/flashcards/node_modules \
			-v lh_plugin_rich_nm:/workspace/plugins/rich-code-blocks/node_modules \
			-v lh_plugin_ui_nm:/workspace/plugins/ui-showcase/node_modules \
			-w /workspace \
			"${IMAGE_NAME}" bash
		;;
	*)
		echo "Unknown command '${CMD}'. Supported: build-image, setup, typecheck, test, lint, build, smoke, baseline, exec, shell" >&2
		exit 2
		;;
esac
