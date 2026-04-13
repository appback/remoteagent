$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if ($root -like "\\wsl.localhost\*") {
  throw "Windows install expects the repository on a local Windows path. Clone RemoteAgent under C:\ or another Windows drive, or use scripts/install.sh inside Linux."
}

$dataDir = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $HOME ".remoteagent" }
$logsDir = Join-Path $dataDir "logs"

New-Item -ItemType Directory -Force -Path $dataDir, $logsDir | Out-Null

$envFile = Join-Path $dataDir ".env"
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $root ".env.example") $envFile
  Write-Host "Created $envFile"
}

$escapedRoot = $root.Replace('"', '\"')
$command = "pushd `"$escapedRoot`" && npm install && npm run build && popd"
cmd.exe /d /c $command

Write-Host ""
Write-Host "RemoteAgent is installed."
Write-Host "Edit $envFile and set TELEGRAM_BOT_TOKEN."
Write-Host "Start with: $root\\scripts\\start.ps1"
