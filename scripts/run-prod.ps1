$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path "$root\.."
Set-Location $projectRoot

. "$root\ensure-venv.ps1"
Ensure-ProjectVenv -ProjectRoot $projectRoot

Set-Location (Join-Path $projectRoot "backend")
python -m app.run_server --host 0.0.0.0 --port 8443
