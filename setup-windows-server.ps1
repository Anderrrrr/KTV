#Requires -Version 5.1

param(
  [ValidateRange(1, 65535)]
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$ruleName = "KTV Server (TCP $Port)"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdministrator) {
  Write-Host 'Requesting administrator permission...'
  $arguments = @(
    '-NoProfile'
    '-ExecutionPolicy'
    'Bypass'
    '-File'
    "`"$PSCommandPath`""
    '-Port'
    $Port
  )
  $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
  exit $process.ExitCode
}

$activeProfiles = @(Get-NetConnectionProfile | Where-Object {
  $_.IPv4Connectivity -ne 'Disconnected'
})
$publicProfiles = @($activeProfiles | Where-Object {
  $_.NetworkCategory -eq 'Public' -and $_.IPv4Connectivity -eq 'Internet'
})

if ($publicProfiles.Count -gt 0) {
  Write-Host ''
  Write-Host 'Active public network(s):'
  $publicProfiles | Format-Table Name, InterfaceAlias, NetworkCategory -AutoSize
  $answer = Read-Host 'Change these trusted networks to Private? [Y/N]'
  if ($answer -notmatch '^(y|yes)$') {
    Write-Error 'The KTV firewall rule only applies to Private networks. Setup was cancelled.'
  }
  $publicProfiles | Set-NetConnectionProfile -NetworkCategory Private
}

$rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($rule) {
  $rule | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Private
  $rule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $Port
  Write-Host "Updated firewall rule: $ruleName"
} else {
  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -Profile Private | Out-Null
  Write-Host "Created firewall rule: $ruleName"
}

$privateAliases = @(Get-NetConnectionProfile | Where-Object {
  $_.NetworkCategory -eq 'Private' -and $_.IPv4Connectivity -ne 'Disconnected'
} | Select-Object -ExpandProperty InterfaceAlias)
$addresses = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
  $_.InterfaceAlias -in $privateAliases -and
  $_.IPAddress -notmatch '^(127\.|169\.254\.)'
} | Select-Object -ExpandProperty IPAddress -Unique)

Write-Host ''
Write-Host 'KTV server setup is complete.'
Write-Host "Admin page: http://localhost:$Port"
foreach ($address in $addresses) {
  Write-Host "LAN address: http://${address}:$Port"
}
Write-Host 'Run start-ktv.cmd to start the server.'

