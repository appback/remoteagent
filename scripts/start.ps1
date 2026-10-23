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

for ($attempt = 0; $attempt -lt 50; $attempt++) {
  $ownerPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  $lockPid = Get-Content (Join-Path $dataDir "remoteagent.lock") -ErrorAction SilentlyContinue
  if ($ownerPid -and $ownerPid -eq $lockPid -and (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) {
    Write-Host "RemoteAgent started with PID $ownerPid"
    Write-Host "Logs: $stdoutLog"
    exit 0
  }
  if ($proc.HasExited) { throw "RemoteAgent startup failed. Inspect $stderrLog" }
  Start-Sleep -Milliseconds 100
}
throw "RemoteAgent PID ownership was not confirmed. Inspect $stderrLog before starting again."
