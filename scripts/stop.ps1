$ErrorActionPreference = "Stop"

$dataDir = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $HOME ".remoteagent" }
$pidFile = Join-Path $dataDir "remoteagent.pid"

if (-not (Test-Path $pidFile)) {
  Write-Host "RemoteAgent is not running."
  exit 0
}

$pid = Get-Content $pidFile
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
if ($proc) {
  Stop-Process -Id $pid
  Write-Host "Stopped RemoteAgent PID $pid"
} else {
  Write-Host "RemoteAgent PID file existed, but process was not running."
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
