#Requires -Version 5.0
<#
  校验本机凭据库里的 gitee.com 凭据是否可用。
  只输出账号名与状态，绝不打印令牌内容。
#>
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'git-cred.ps1')

$r = Invoke-GitCredential -Action 'fill' -InputText "protocol=https`nhost=gitee.com`n`n"
$out = [string]$r.output

$user = ''
$token = ''
foreach ($line in ($out -split "`r?`n")) {
  if ($line -match '^username=(.*)$') { $user = $Matches[1] }
  if ($line -match '^password=(.*)$') { $token = $Matches[1] }
}

if ([string]::IsNullOrWhiteSpace($token)) {
  Write-Output 'RESULT=NO_CREDENTIAL'
  exit 1
}

$masked = ''
if ($token.Length -ge 8) {
  $masked = $token.Substring(0, 4) + '…' + $token.Substring($token.Length - 4)
} else {
  $masked = '（过短）'
}

Write-Output ("USER=" + $user)
Write-Output ("TOKEN_LEN=" + $token.Length + " MASKED=" + $masked)

try {
  $resp = Invoke-RestMethod -Uri ('https://gitee.com/api/v5/user?access_token=' + [uri]::EscapeDataString($token)) -Method Get -TimeoutSec 25
  Write-Output ("RESULT=OK LOGIN=" + $resp.login)
} catch {
  $status = 0
  try { $status = [int]$_.Exception.Response.StatusCode } catch { }
  Write-Output ("RESULT=FAIL STATUS=" + $status + " MSG=" + $_.Exception.Message)
  exit 1
} finally {
  $token = $null
  [System.GC]::Collect()
}
