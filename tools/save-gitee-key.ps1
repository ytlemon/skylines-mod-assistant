#Requires -Version 5.0
<#
  把 Gitee 私人令牌保存到本机 Git 凭据管理器（Windows 凭据管理器）。
  - 优先直接读取剪贴板，避开控制台粘贴被截断的问题
  - 剪贴板不可用时弹出系统密码输入框（可正常粘贴）
  - 不打印、不写日志、不落明文文件
  - 校验失败可原地重试，不必重开窗口
#>
$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = '保存 Gitee 密钥到本机凭据库'
. (Join-Path $PSScriptRoot 'git-cred.ps1')

function Write-Title($text) { Write-Host $text -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host $text -ForegroundColor Green }
function Write-Bad($text) { Write-Host $text -ForegroundColor Red }
function Write-Warn2($text) { Write-Host $text -ForegroundColor Yellow }
function Write-Dim($text) { Write-Host $text -ForegroundColor DarkGray }
function Write-Line { Write-Host '' }

function Show-Masked($token) {
  if ([string]::IsNullOrEmpty($token)) { return '（空）' }
  if ($token.Length -lt 8) { return "（过短：$($token.Length) 个字符）" }
  return $token.Substring(0, 4) + '…' + $token.Substring($token.Length - 4) + "（$($token.Length) 个字符）"
}

# 系统密码输入框：粘贴、显示为圆点，比控制台粘贴可靠
function Read-TokenFromDialog {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  Add-Type -AssemblyName System.Drawing | Out-Null

  $form = New-Object System.Windows.Forms.Form
  $form.Text = '输入 Gitee 私人令牌'
  $form.Size = New-Object System.Drawing.Size(520, 190)
  $form.StartPosition = 'CenterScreen'
  $form.TopMost = $true
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false

  $label = New-Object System.Windows.Forms.Label
  $label.Text = '令牌（32 位字符，粘贴后点确定）：'
  $label.Location = New-Object System.Drawing.Point(18, 16)
  $label.AutoSize = $true
  $form.Controls.Add($label)

  $box = New-Object System.Windows.Forms.TextBox
  $box.Location = New-Object System.Drawing.Point(20, 44)
  $box.Size = New-Object System.Drawing.Size(462, 26)
  $box.UseSystemPasswordChar = $true
  $form.Controls.Add($box)

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = '确定'
  $ok.Location = New-Object System.Drawing.Point(300, 88)
  $ok.Size = New-Object System.Drawing.Size(88, 30)
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $form.Controls.Add($ok)

  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = '取消'
  $cancel.Location = New-Object System.Drawing.Point(394, 88)
  $cancel.Size = New-Object System.Drawing.Size(88, 30)
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.Controls.Add($cancel)

  $form.AcceptButton = $ok
  $form.CancelButton = $cancel
  $form.Add_Shown({ $box.Focus() })

  $result = $form.ShowDialog()
  $text = $box.Text
  $form.Dispose()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) { return '' }
  return $text
}

function Read-TokenFromClipboard {
  try {
    $text = Get-Clipboard -Raw -ErrorAction Stop
    if ($null -eq $text) { return '' }
    return [string]$text
  } catch {
    return ''
  }
}

function Normalize-Token($raw) {
  if ([string]::IsNullOrEmpty($raw)) { return '' }
  # 去掉首尾空白、引号、可能的 "token" 前缀与网址残留
  $t = $raw.Trim()
  $t = $t.Trim('"').Trim("'")
  $t = $t -replace '^\s*(token|access_token)\s*[:=]\s*', ''
  $t = $t -replace '\s+', ''
  return $t
}

# 返回 @{ ok; login; status; reason }
function Test-GiteeToken($token) {
  $escaped = [uri]::EscapeDataString($token)
  $firstError = ''
  $msg1 = ''
  $status1 = 0

  try {
    $resp = Invoke-RestMethod -Uri ('https://gitee.com/api/v5/user?access_token=' + $escaped) -Method Get -TimeoutSec 25
    $login = $resp.login; if (-not $login) { $login = $resp.name }
    return @{ ok = $true; login = $login; status = 200; reason = '' }
  } catch {
    $msg1 = $_.Exception.Message
    try { $status1 = [int]$_.Exception.Response.StatusCode } catch { $status1 = 0 }
  }

  try {
    $headers = @{ Authorization = "token $token" }
    $resp2 = Invoke-RestMethod -Uri 'https://gitee.com/api/v5/user' -Headers $headers -Method Get -TimeoutSec 25
    $login2 = $resp2.login; if (-not $login2) { $login2 = $resp2.name }
    return @{ ok = $true; login = $login2; status = 200; reason = '' }
  } catch {
    $msg2 = $_.Exception.Message
    try { $status2 = [int]$_.Exception.Response.StatusCode } catch { $status2 = 0 }
  }

  $status = $status2
  if (-not $status) { $status = $status1 }
  $reason = $msg2
  if ([string]::IsNullOrWhiteSpace($reason)) { $reason = $msg1 }
  return @{ ok = $false; login = ''; status = $status; reason = $reason }
}

Write-Title '=========================================='
Write-Title '  天际线 Mod 助手 · Gitee 密钥保存器'
Write-Title '=========================================='
Write-Line
Write-Dim '做法：在浏览器里选中并复制令牌（Ctrl+C），回到本窗口按回车即可'
Write-Dim '脚本直接读剪贴板，不经过控制台粘贴，避免被截断成 1 个字符'
Write-Dim '令牌在 gitee.com → 设置 → 私人令牌 生成，勾选 projects'
Write-Line

$defaultUser = 'ytlemon'
$user = Read-Host "Gitee 用户名（直接回车 = $defaultUser）"
if ([string]::IsNullOrWhiteSpace($user)) { $user = $defaultUser }
$user = $user.Trim()
Write-Warn2 "  → 用户名：$user"
Write-Line

$token = ''
$verified = $false
$login = ''

for ($round = 1; $round -le 6; $round++) {
  Write-Host '请先在浏览器复制令牌，然后按回车读取剪贴板… ' -ForegroundColor Cyan -NoNewline
  $null = Read-Host
  $raw = Read-TokenFromClipboard
  $token = Normalize-Token $raw

  if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Bad '剪贴板里没有可用内容。'
    Write-Dim '  → 按 [e] 可以改用弹窗手动粘贴（弹窗里粘贴不会截断）'
    $pick = Read-Host '[e] 弹窗输入   [r] 重新读剪贴板   [q] 退出'
    if ($pick -match '^[qQ]') { exit 1 }
    if ($pick -match '^[eE]') {
      $token = Normalize-Token (Read-TokenFromDialog)
    }
    if ([string]::IsNullOrWhiteSpace($token)) { continue }
  }

  Write-Warn2 "  → 读到：$(Show-Masked $token)"
  if ($token.Length -ne 32) {
    Write-Dim '  → 提示：Gitee 私人令牌通常是 32 位；长度不符多半是复制不完整'
  }
  if ($token -notmatch '^[A-Za-z0-9_\-\.]+$') {
    Write-Bad '  → 内容里有非令牌字符（空格、中文、换行等），可能复制到了别的东西'
  }

  Write-Host '正在向 gitee.com 验证…' -NoNewline
  $result = Test-GiteeToken $token

  if ($result.ok) {
    Write-Host ' 通过' -ForegroundColor Green
    Write-Ok "  → 账号：$($result.login)"
    $verified = $true
    $login = $result.login
    break
  }

  Write-Host ' 失败' -ForegroundColor Red
  if ($result.status -eq 401) {
    Write-Bad '  → 401 未授权：Gitee 不认这个令牌'
    Write-Dim '  → 若长度不是 32，多半是复制漏了；若是 32 位仍失败，则该令牌已过期/被重置'
    Write-Dim '  → 重新生成：gitee.com/profile/personal_access_tokens'
  } elseif ($result.status -eq 403) {
    Write-Bad '  → 403 权限不足或触发限流（生成时至少勾选 projects）'
  } elseif ($result.status -eq 404) {
    Write-Bad '  → 404 接口不可达，可能是网络拦截或代理'
  } else {
    Write-Bad "  → 原因：$($result.reason)"
  }
  Write-Line
  Write-Host '[r] 重来（重新复制后回车）   [e] 弹窗输入   [s] 跳过验证硬存   [q] 退出' -ForegroundColor Cyan
  $choice = Read-Host '请选择'
  if ($choice -match '^[qQ]') {
    Write-Bad '已退出，未保存任何内容。'
    $token = $null
    exit 1
  }
  if ($choice -match '^[sS]') { Write-Warn2 '跳过验证直接保存'; break }
  if ($choice -match '^[eE]') {
    $token = Normalize-Token (Read-TokenFromDialog)
    if ([string]::IsNullOrWhiteSpace($token)) { continue }
    Write-Warn2 "  → 读到：$(Show-Masked $token)"
    $result = Test-GiteeToken $token
    if ($result.ok) {
      $verified = $true
      $login = $result.login
      Write-Ok "  验证通过 · 账号 $login"
      break
    }
    Write-Bad '  仍然失败，继续重试'
  }
  Write-Line
}

if ([string]::IsNullOrWhiteSpace($token)) {
  Write-Bad '没有可保存的令牌，已退出。'
  exit 1
}

Write-Line
$payload = "protocol=https`nhost=gitee.com`nusername=$user`npassword=$token`n`n"
$approved = $false
try {
  $r = Invoke-GitCredential -Action 'approve' -InputText $payload
  if ($r.code -ne 0) {
    $errMsg = [string]$r.error
    if ([string]::IsNullOrWhiteSpace($errMsg)) { $errMsg = "git 退出码 $($r.code)" }
    throw $errMsg
  }
  $approved = $true
  Write-Ok '已写入本机 Git 凭据管理器（host=gitee.com）'
} catch {
  Write-Bad "写入失败：$($_.Exception.Message)"
  Write-Dim '若提示找不到 git，请确认已安装 Git 并在 PATH 中。'
  $token = $null
  exit 1
}

$check = ''
if ($approved) {
  $r2 = Invoke-GitCredential -Action 'fill' -InputText "protocol=https`nhost=gitee.com`n`n"
  $check = [string]$r2.output
}
Write-Line
if (($check -match 'username=(.+)') -and ($check -match 'password=')) {
  Write-Ok '回读校验通过：凭据库中已存在 gitee.com 的用户名与密码。'
} else {
  Write-Warn2 '回读未拿到凭据，但写入命令已成功（部分 Git 助手不返回密码）。'
}

$token = $null
[System.GC]::Collect()

Write-Line
Write-Title '=========================================='
if ($verified) { Write-Ok "  完成 · 已验证 $login" } else { Write-Warn2 '  已保存，但未通过验证' }
Write-Title '=========================================='
Write-Dim '接下来：打开「天际线 Mod 助手」→ 源与设置 → Gitee 卡片 → 从 Git 读取 → 保存'
Write-Line
