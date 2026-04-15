$ErrorActionPreference = "Stop"

$dataDir = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $HOME ".remoteagent" }
$pidFile = Join-Path $dataDir "remoteagent.pid"

function Get-DescendantProcessIds {
  param(
    [int]$ParentId
  )

  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentId" -ErrorAction SilentlyContinue)
  $ids = @()

  foreach ($child in $children) {
    $ids += [int]$child.ProcessId
    $ids += @(Get-DescendantProcessIds -ParentId ([int]$child.ProcessId))
  }

  return $ids
}

if (-not (Test-Path $pidFile)) {
  Write-Host "RemoteAgent is not running."
  exit 0
}

$remoteAgentPid = [int](Get-Content $pidFile)
$allPids = @($remoteAgentPid) + @(Get-DescendantProcessIds -ParentId $remoteAgentPid)
$runningPids = @($allPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })

if ($runningPids.Count -gt 0) {
  $runningPids = @($runningPids | Sort-Object -Descending)
  $runningPids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }

  Write-Host "Stopped RemoteAgent process tree: $($runningPids -join ', ')"
} else {
  Write-Host "RemoteAgent PID file existed, but process was not running."
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
