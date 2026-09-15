$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path "$root\.."
Set-Location $projectRoot

. "$root\ensure-venv.ps1"
Ensure-ProjectVenv -ProjectRoot $projectRoot

& ".\.venv\Scripts\python.exe" -m pip install -r backend\requirements-dev.txt

Set-Location backend
pytest
Set-Location ..

Set-Location frontend
npm install
npm test -- --run
npm run build
