[CmdletBinding(PositionalBinding = $false)]
param(
	[Parameter(Position = 0, ValueFromRemainingArguments = $true)]
	[string[]]$E2EArgs = @("--selfcheck"),
	[string]$Image = "learnharness-e2e:local",
	[string]$ArtifactsDir = "",
	[switch]$BuildImage
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$E2EDir = Join-Path $RepoRoot "tests\e2e"

if ($BuildImage) {
	Write-Host "[e2e] Building Docker image $Image from $E2EDir..."
	& docker build -t $Image -f (Join-Path $E2EDir "Dockerfile") $E2EDir
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$AutoArtifacts = $false
if (-not $ArtifactsDir) {
	$AutoArtifacts = $true
	$ArtifactsDir = Join-Path ([System.IO.Path]::GetTempPath()) ("lh-e2e-artifacts-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
}
New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null
$ArtifactsDir = (Resolve-Path $ArtifactsDir).Path

$DockerArgs = @(
	"run", "--init", "--rm", "--shm-size=1gb",
	"-v", "${RepoRoot}:/repo:ro",
	"-v", "lh_e2e_work:/work",
	"-v", "${ArtifactsDir}:/artifacts:rw",
	$Image,
	"bash", "/repo/tests/e2e/run-docker-e2e.sh"
) + $E2EArgs

$ExitCode = 1
try {
	Write-Host "[e2e] Running in Docker ($Image): $($E2EArgs -join ' ')"
	& docker @DockerArgs
	$ExitCode = $LASTEXITCODE
} finally {
	if ($AutoArtifacts) {
		if ($ExitCode -eq 0) {
			Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $ArtifactsDir
		} else {
			Write-Host "[e2e] Artifacts preserved at: $ArtifactsDir"
		}
	}
}
exit $ExitCode
