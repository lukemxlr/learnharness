$Command = if ($args.Count -gt 0) { [string]$args[0] } else { "baseline" }
$Rest = if ($args.Count -gt 1) { [string[]]$args[1..($args.Count - 1)] } else { @() }

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ImageName = if ($env:LH_DOCKER_IMAGE) { $env:LH_DOCKER_IMAGE } else { "learnharness-test:node26" }

function Invoke-DockerBuild {
    Write-Host "[docker-test] Building image $ImageName from docker/Dockerfile.test..."
    & docker build -f (Join-Path $RepoRoot "docker\Dockerfile.test") -t $ImageName $RepoRoot
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Ensure-Image {
    & docker image inspect $ImageName *> $null
    if ($LASTEXITCODE -ne 0) {
        Invoke-DockerBuild
    }
}

function Invoke-InContainer {
    param(
        [string]$ShellCmd,
        [switch]$Interactive
    )
    Ensure-Image
    $dockerArgs = @(
        "run", "--rm", "--init"
    )
    if ($Interactive) {
        $dockerArgs += "-it"
    }
    $dockerArgs += @(
        "-e", "NEXT_TELEMETRY_DISABLED=1",
        "-e", "LH_DATA_DIR=/tmp/lh-test-data",
        "-e", "LH_AUTH_FILE=/tmp/lh-test-auth/auth.json",
        "-v", "${RepoRoot}:/workspace",
        "-v", "lh_node_modules:/workspace/node_modules",
        "-v", "lh_next:/workspace/.next",
        "-v", "lh_core_plugins:/workspace/core-plugins",
        "-v", "lh_plugin_coding_nm:/workspace/plugins/coding-questions/node_modules",
        "-v", "lh_plugin_drawing_nm:/workspace/plugins/drawing-pad/node_modules",
        "-v", "lh_plugin_flashcards_nm:/workspace/plugins/flashcards/node_modules",
        "-v", "lh_plugin_rich_nm:/workspace/plugins/rich-code-blocks/node_modules",
        "-v", "lh_plugin_ui_nm:/workspace/plugins/ui-showcase/node_modules",
        "-w", "/workspace",
        $ImageName
    )
    if ($Interactive -and -not $ShellCmd) {
        $dockerArgs += @("bash")
    } else {
        $dockerArgs += @("bash", "-lc", "mkdir -p /tmp/lh-test-data /tmp/lh-test-auth && $ShellCmd")
    }
    & docker @dockerArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Escape-BashArgs {
    param([string[]]$Items)
    return ($Items | ForEach-Object { "'" + ($_ -replace "'", "'`"'`"'") + "'" }) -join " "
}

switch ($Command) {
    "build-image" {
        Invoke-DockerBuild
    }
    "setup" {
        Invoke-InContainer "npm ci && npm run plugins:setup"
    }
    "typecheck" {
        Invoke-InContainer "npm run typecheck"
    }
    "test" {
        if ($Rest -and $Rest.Count -gt 0) {
            $escaped = Escape-BashArgs $Rest
            Invoke-InContainer "NODE_ENV=test ./node_modules/.bin/tsx --test $escaped"
        } else {
            Invoke-InContainer "npm test"
        }
    }
    "lint" {
        Invoke-InContainer "npm run lint"
    }
    "build" {
        Invoke-InContainer "npm run build"
    }
    "smoke" {
        Invoke-InContainer "node scripts/smoke-provider-runtime.mjs && node scripts/build-server.mjs && node scripts/smoke-server.mjs --isolated"
    }
    "baseline" {
        Invoke-InContainer "npm ci && npm run plugins:setup && npm run typecheck && npm test && npm run lint && npm run build && node scripts/smoke-provider-runtime.mjs && node scripts/build-server.mjs && node scripts/smoke-server.mjs --isolated"
    }
    "exec" {
        if (-not $Rest -or $Rest.Count -eq 0) {
            throw "Usage: docker-test.ps1 exec <command...>"
        }
        $joined = $Rest -join " "
        Invoke-InContainer $joined
    }
    "shell" {
        Invoke-InContainer -Interactive
    }
    default {
        Write-Error "Unknown command '$Command'. Supported: build-image, setup, typecheck, test, lint, build, smoke, baseline, exec, shell"
        exit 2
    }
}
