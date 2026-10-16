# Thrift Go launcher - idempotent: starts whatever is missing, never duplicates.
# Runs at logon via scheduled task 'ThriftGoStack'. Safe to run manually anytime.
$ErrorActionPreference = 'SilentlyContinue'
# Project root is the parent of this script's folder, so the file works from any checkout location.
$dir = Split-Path -Parent $PSScriptRoot
$cf = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$logFile = Join-Path $dir 'logs\ensure-running.log'
function Note($msg) { Add-Content -Path $logFile -Value ("{0} {1}" -f (Get-Date -Format o), $msg) -Encoding UTF8 }

# 1) server on 4331
$listening = Get-NetTCPConnection -LocalPort 4331 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Note 'server already listening on 4331 - skipped'
} else {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
  Start-Process -FilePath $node -ArgumentList 'src/server.js' -WorkingDirectory $dir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $dir 'logs\server-stdout.log') -RedirectStandardError (Join-Path $dir 'logs\server-stderr.log')
  Note "server started (node: $node)"
}

# 2) stable tunnel (named 'thrift-go')
$tunnel = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -match 'run\s+thrift-go' }
if ($tunnel) {
  Note 'tunnel already running - skipped'
} else {
  Start-Process -FilePath $cf -ArgumentList 'tunnel', '--config', (Join-Path $dir 'cloudflared.yml'), 'run', 'thrift-go' -WindowStyle Hidden `
    -RedirectStandardError (Join-Path $dir 'logs\tunnel.log') -RedirectStandardOutput (Join-Path $dir 'logs\tunnel-out.log')
  Note 'tunnel started'
}
