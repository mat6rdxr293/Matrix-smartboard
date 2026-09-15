$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path "$root\.."
Set-Location $projectRoot

. "$root\ensure-venv.ps1"
Ensure-ProjectVenv -ProjectRoot $projectRoot

$cert = $env:CERT_FILE
$key = $env:KEY_FILE

if ([string]::IsNullOrWhiteSpace($cert)) {
  $cert = Join-Path $projectRoot "certs\\fullchain.pem"
}
if ([string]::IsNullOrWhiteSpace($key)) {
  $key = Join-Path $projectRoot "certs\\privkey.pem"
}

if (-not (Test-Path $cert) -or -not (Test-Path $key)) {
  Write-Host "Cert files not found. Expected:"
  Write-Host "  $cert"
  Write-Host "  $key"
  Write-Host "Set CERT_FILE and KEY_FILE env vars to override."
  exit 1
}

Set-Location (Join-Path $projectRoot "backend")
python -m uvicorn app.proxy:app --host 0.0.0.0 --port 444 --ssl-certfile $cert --ssl-keyfile $key
