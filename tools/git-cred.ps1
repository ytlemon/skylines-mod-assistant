#Requires -Version 5.0
<#
  git credential 调用封装。
  Windows PowerShell 5.1 把字符串管道喂给原生 exe 时会丢内容
  （git 报 "refusing to work with credential missing protocol field"），
  所以统一改成：写临时文件 → Start-Process 重定向 stdin/stdout → 覆写清零并删除。
#>

function Invoke-GitCredential {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('approve', 'fill', 'reject')][string]$Action,
    [Parameter(Mandatory = $true)][string]$InputText
  )

  $id = [guid]::NewGuid().ToString('N')
  $inFile = Join-Path $env:TEMP "nm-cred-in-$id.txt"
  $outFile = Join-Path $env:TEMP "nm-cred-out-$id.txt"
  $errFile = Join-Path $env:TEMP "nm-cred-err-$id.txt"
  $utf8 = New-Object System.Text.UTF8Encoding($false)

  try {
    [System.IO.File]::WriteAllText($inFile, $InputText, $utf8)
    $proc = Start-Process -FilePath 'git' `
      -ArgumentList @('credential', $Action) `
      -RedirectStandardInput $inFile `
      -RedirectStandardOutput $outFile `
      -RedirectStandardError $errFile `
      -NoNewWindow -Wait -PassThru

    $out = ''
    $err = ''
    if (Test-Path $outFile) { $out = [System.IO.File]::ReadAllText($outFile) }
    if (Test-Path $errFile) { $err = [System.IO.File]::ReadAllText($errFile) }

    return @{ code = $proc.ExitCode; output = $out; error = $err.Trim() }
  } finally {
    foreach ($f in @($inFile, $outFile, $errFile)) {
      try {
        if (Test-Path $f) {
          $len = (Get-Item $f).Length
          if ($len -gt 0) { [System.IO.File]::WriteAllBytes($f, (New-Object byte[] $len)) }
          Remove-Item $f -Force -ErrorAction SilentlyContinue
        }
      } catch { }
    }
  }
}
