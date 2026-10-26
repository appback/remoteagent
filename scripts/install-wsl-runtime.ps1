param(
  [string]$Distribution = 'Ubuntu',
  [string]$TaskName = 'RemoteAgent-WSL-Ubuntu'
)
$ErrorActionPreference = 'Stop'
if ($Distribution -notmatch '^[A-Za-z0-9._-]+$') { throw 'Invalid WSL distribution name.' }
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wsl.exe" -Argument "-d $Distribution --exec /bin/sleep infinity"
$triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $user),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1))
)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description 'Keep WSL available for the RemoteAgent user service. Retry after WSL exits; never create a second receiver.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName,State
Write-Output 'Requires an enabled RemoteAgent user service inside WSL. Windows sleep, logout, or shutdown still suspends availability.'
