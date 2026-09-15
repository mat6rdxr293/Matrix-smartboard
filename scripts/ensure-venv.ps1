function Test-ProjectVenv {
  param(
    [Parameter(Mandatory = $true)]
    [string]$VenvPython
  )

  if (-not (Test-Path $VenvPython)) {
    return $false
  }

  try {
    & $VenvPython -c "import sys" *> $null
    return ($LASTEXITCODE -eq 0)
  }
  catch {
    return $false
  }
}

function New-ProjectVenv {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot
  )

  $venvPath = Join-Path $ProjectRoot ".venv"
  $pyLauncher = Get-Command py -ErrorAction SilentlyContinue

  if ($pyLauncher) {
    foreach ($version in @("3.12", "3.11", "3.10", "3")) {
      & py -$version -c "import sys" *> $null
      if ($LASTEXITCODE -eq 0) {
        & py -$version -m venv $venvPath
        if ($LASTEXITCODE -eq 0) {
          return
        }
      }
    }
  }

  python -m venv $venvPath
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create virtual environment in $venvPath."
  }
}

function Ensure-ProjectVenv {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,
    [string]$RequirementsRelativePath = "backend\requirements.txt"
  )

  $venvPath = Join-Path $ProjectRoot ".venv"
  $venvPython = Join-Path $venvPath "Scripts\python.exe"

  if (-not (Test-ProjectVenv -VenvPython $venvPython)) {
    if (Test-Path $venvPath) {
      Write-Host "Broken .venv detected. Recreating..."
      Remove-Item -Recurse -Force $venvPath
    }

    New-ProjectVenv -ProjectRoot $ProjectRoot
  }

  . (Join-Path $venvPath "Scripts\Activate.ps1")

  $requirementsPath = Join-Path $ProjectRoot $RequirementsRelativePath
  python -m pip install -r $requirementsPath
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install Python dependencies from $requirementsPath."
  }
}
