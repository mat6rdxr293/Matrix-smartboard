$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path "$root\.."
Set-Location $projectRoot

. "$root\ensure-venv.ps1"
Ensure-ProjectVenv -ProjectRoot $projectRoot

Set-Location frontend
npm install
npm run build
Set-Location ..

$static = "backend\app\static"
if (Test-Path $static) { Remove-Item -Recurse -Force $static }
New-Item -ItemType Directory -Force -Path $static | Out-Null
Copy-Item -Recurse -Force "frontend\dist\*" $static
