$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if ($root -like "\\wsl.localhost\*") {
  throw "Windows start expects the repository on a local Windows path. Clone RemoteAgent under C:\ or another Windows drive, or use scripts/start.sh inside Linux."
}

$dataDir = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $HOME ".remoteagent" }
$logsDir = Join-Path $dataDir "logs"
$pidFile = Join-Path $dataDir "remoteagent.pid"
$stdoutLog = Join-Path $logsDir "agent.stdout.log"
$stderrLog = Join-Path $logsDir "agent.stderr.log"

New-Item -ItemType Directory -Force -Path $dataDir, $logsDir | Out-Null

if (Test-Path $pidFile) {
  $existingPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($existingPid -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
    Write-Host "RemoteAgent is already running with PID $existingPid"
    exit 0
  }
}

$escapedDataDir = $dataDir.Replace('"', '\"')
$escapedRoot = $root.Replace('"', '\"')
$command = "pushd `"$escapedRoot`" && set DATA_DIR=$escapedDataDir && npm run start && popd"

$proc = Start-Process -FilePath "cmd.exe" `
  -ArgumentList @("/d", "/c", $command) `
  -WorkingDirectory $root `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -WindowStyle Hidden `
  -PassThru

Set-Content -Path $pidFile -Value $proc.Id

Write-Host "RemoteAgent started with PID $($proc.Id)"
Write-Host "Logs: $stdoutLog"
