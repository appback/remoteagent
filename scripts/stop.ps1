$ErrorActionPreference = "Stop"

$dataDir = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $HOME ".remoteagent" }
$pidFile = Join-Path $dataDir "remoteagent.pid"

if (-not (Test-Path $pidFile)) {
  Write-Host "RemoteAgent is not running."
  exit 0
}

$remoteAgentPid = Get-Content $pidFile
$proc = Get-Process -Id $remoteAgentPid -ErrorAction SilentlyContinue
if ($proc) {
  Stop-Process -Id $remoteAgentPid
  Write-Host "Stopped RemoteAgent PID $remoteAgentPid"
} else {
  Write-Host "RemoteAgent PID file existed, but process was not running."
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
