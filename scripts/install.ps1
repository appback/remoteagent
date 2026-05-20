$ErrorActionPreference = "Stop"

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dataDir = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $env:USERPROFILE ".remoteagent" }
$envFile = Join-Path $dataDir ".env"

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir "logs") | Out-Null

if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $rootDir ".env.example") $envFile
  Write-Host "Created $envFile"
}

function Set-EnvValue {
  param(
    [string]$Path,
    [string]$Key,
    [string]$Value
  )

  $content = if (Test-Path $Path) { Get-Content $Path } else { @() }
  $updated = $false
  $result = foreach ($line in $content) {
    if ($line -like "$Key=*") {
      $updated = $true
      "$Key=$Value"
    } else {
      $line
    }
  }
  if (-not $updated) {
    $result += "$Key=$Value"
  }
  Set-Content -Path $Path -Value $result
}

Set-EnvValue -Path $envFile -Key "SETUP_COMMAND_TIMEOUT_MS" -Value "600000"
Set-EnvValue -Path $envFile -Key "CODEX_INSTALL_COMMAND" -Value "$rootDir/scripts/install-codex.sh"
Set-EnvValue -Path $envFile -Key "CLAUDE_INSTALL_COMMAND" -Value "$rootDir/scripts/install-claude.sh"
Set-EnvValue -Path $envFile -Key "CLAUDE_LOGIN_START_COMMAND" -Value "$rootDir/scripts/start-claude-login.sh"
Set-EnvValue -Path $envFile -Key "CLAUDE_LOGIN_FINISH_COMMAND" -Value "$rootDir/scripts/finish-claude-login.sh"

npm --prefix $rootDir install
npm --prefix $rootDir run build

Write-Host ""
Write-Host "RemoteAgent is installed."
Write-Host "Provider install/login hooks were configured in $envFile"
Write-Host "Set TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKENS in $envFile"
Write-Host "Start with: $rootDir/scripts/start.ps1"