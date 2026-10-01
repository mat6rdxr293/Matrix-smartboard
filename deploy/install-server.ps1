Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoZipUrl = "https://github.com/mat6rdxr293/Matrix-smartboard/archive/refs/heads/main.zip"
$RootDir = Join-Path $env:ProgramData "MatrixSmartboard"
$AppDir = Join-Path $RootDir "app"
$DataDir = Join-Path $RootDir "data"
$Port = if ($env:MATRIX_PORT) { [int]$env:MATRIX_PORT } else { 8443 }
$PublicBaseUrl = [string]$env:MATRIX_PUBLIC_BASE_URL
$InstallOllama = if ($env:MATRIX_INSTALL_OLLAMA) { $env:MATRIX_INSTALL_OLLAMA -eq "1" } else { $true }
$ServerName = ([string]$env:MATRIX_SERVER_NAME -replace "[\r\n\t]+", " ").Trim()
if ($ServerName.Length -gt 48) { $ServerName = $ServerName.Substring(0, 48) }

function Write-Step([string]$Text) {
    Write-Output $Text
}

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
    Write-Error "Windows SSH setup requires an account in the local Administrators group."
    exit 2
}

if ($Port -lt 1 -or $Port -gt 65535) {
    Write-Error "Invalid MATRIX_PORT"
    exit 2
}

New-Item -ItemType Directory -Force -Path $RootDir, $DataDir | Out-Null

function Find-Python {
    $command = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($command) {
        try {
            & $command.Source -c "import sys; assert sys.version_info >= (3,11)" 2>$null
            if ($LASTEXITCODE -eq 0) { return $command.Source }
        } catch {}
    }

    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        try {
            $resolved = (& $launcher.Source -3 -c "import sys; print(sys.executable)" 2>$null | Select-Object -First 1).Trim()
            if ($resolved -and (Test-Path $resolved)) { return $resolved }
        } catch {}
    }

    foreach ($candidate in @(
        "$env:ProgramFiles\Python314\python.exe",
        "$env:ProgramFiles\Python313\python.exe",
        "$env:ProgramFiles\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python314\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
    )) {
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

function Install-WingetPackage([string]$Id) {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    $wingetPath = if ($winget) { $winget.Source } else { Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\winget.exe" }
    if (-not (Test-Path $wingetPath)) {
        Write-Error "winget is required to install missing Windows prerequisites automatically."
        exit 3
    }

    & $wingetPath install --id $Id -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) {
        Write-Error "winget failed to install $Id (exit $LASTEXITCODE)"
        exit 3
    }
}

Write-Step "[1/7] Checking Windows prerequisites"
$Python = Find-Python
if (-not $Python) {
    Write-Output "Python 3.11+ not found; installing Python 3.13 with winget"
    Install-WingetPackage "Python.Python.3.13"
    $Python = Find-Python
}
if (-not $Python) {
    Write-Error "Python installation completed but python.exe could not be located."
    exit 3
}

Write-Step "[2/7] Preparing service directories"
$BackendTaskName = "Matrix Smartboard Server"
$OllamaTaskName = "Matrix Smartboard Ollama"
$ExistingBackendTask = Get-ScheduledTask -TaskName $BackendTaskName -ErrorAction SilentlyContinue
if ($ExistingBackendTask) {
    $ExistingBackendTask | Stop-ScheduledTask -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 20; $i++) {
        $state = (Get-ScheduledTask -TaskName $BackendTaskName -ErrorAction SilentlyContinue).State
        if ($state -ne "Running") { break }
        Start-Sleep -Milliseconds 250
    }
}

Write-Step "[3/7] Downloading Matrix Smartboard from GitHub"
$TempRoot = Join-Path $env:TEMP ("matrix-smartboard-" + [Guid]::NewGuid().ToString("N"))
$ZipPath = Join-Path $TempRoot "main.zip"
$ExtractPath = Join-Path $TempRoot "extract"
New-Item -ItemType Directory -Force -Path $TempRoot, $ExtractPath | Out-Null

try {
    Invoke-WebRequest -UseBasicParsing -Uri $RepoZipUrl -OutFile $ZipPath
    Expand-Archive -Path $ZipPath -DestinationPath $ExtractPath -Force
    $SourceDir = Get-ChildItem -Path $ExtractPath -Directory | Select-Object -First 1
    if (-not $SourceDir) { throw "Downloaded repository archive is empty" }

    if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
    New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
    Copy-Item -Path (Join-Path $SourceDir.FullName "*") -Destination $AppDir -Recurse -Force
} finally {
    Remove-Item -Recurse -Force $TempRoot -ErrorAction SilentlyContinue
}

Write-Step "[4/7] Installing Python backend"
$VenvPython = Join-Path $AppDir ".venv\Scripts\python.exe"
& $Python -m venv (Join-Path $AppDir ".venv")
if ($LASTEXITCODE -ne 0) { throw "Failed to create Python virtual environment" }
& $VenvPython -m pip install --upgrade pip wheel
if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip" }
& $VenvPython -m pip install -r (Join-Path $AppDir "backend\requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Failed to install backend dependencies" }

function Find-Ollama {
    $command = Get-Command ollama.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($candidate in @(
        "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
        "$env:ProgramFiles\Ollama\ollama.exe"
    )) {
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

$AiBaseUrl = ""
$OcrBaseUrl = ""
$AiModel = "qwen2.5:7b"
$OcrModel = "qwen2.5vl:3b"
$OllamaModels = Join-Path $DataDir "ollama\models"

if ($InstallOllama) {
    Write-Step "[5/7] Configuring local AI (Ollama)"
    $Ollama = Find-Ollama
    if (-not $Ollama) {
        Write-Output "Ollama not found; installing with winget"
        Install-WingetPackage "Ollama.Ollama"
        $Ollama = Find-Ollama
    }
    if (-not $Ollama) {
        Write-Error "Ollama installation completed but ollama.exe could not be located."
        exit 3
    }

    New-Item -ItemType Directory -Force -Path $OllamaModels | Out-Null
    $RunOllama = Join-Path $RootDir "run-ollama.ps1"
    @"
`$env:OLLAMA_HOST = "127.0.0.1:11434"
`$env:OLLAMA_MODELS = "$($OllamaModels.Replace('"','""'))"
& "$($Ollama.Replace('"','""'))" serve *>> "$((Join-Path $RootDir "ollama.log").Replace('"','""'))"
"@ | Set-Content -Path $RunOllama -Encoding UTF8

    $OllamaAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$RunOllama`""
    $StartupTrigger = New-ScheduledTaskTrigger -AtStartup
    $SystemPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $TaskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName $OllamaTaskName -Action $OllamaAction -Trigger $StartupTrigger -Principal $SystemPrincipal -Settings $TaskSettings -Force | Out-Null
    Get-Process ollama -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Start-ScheduledTask -TaskName $OllamaTaskName

    $env:OLLAMA_HOST = "127.0.0.1:11434"
    $env:OLLAMA_MODELS = $OllamaModels
    $OllamaReady = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 2
            if ($response.StatusCode -eq 200) { $OllamaReady = $true; break }
        } catch {}
        Start-Sleep -Seconds 2
    }
    if (-not $OllamaReady) { throw "Ollama did not become ready" }

    & $Ollama pull $AiModel
    if ($LASTEXITCODE -ne 0) { throw "Failed to download $AiModel" }
    & $Ollama pull $OcrModel
    if ($LASTEXITCODE -ne 0) { throw "Failed to download $OcrModel" }
    $AiBaseUrl = "http://127.0.0.1:11434/v1"
    $OcrBaseUrl = "http://127.0.0.1:11434/v1"
} else {
    Write-Step "[5/7] Local AI installation skipped"
    $ExistingOllamaTask = Get-ScheduledTask -TaskName $OllamaTaskName -ErrorAction SilentlyContinue
    if ($ExistingOllamaTask) {
        $ExistingOllamaTask | Stop-ScheduledTask -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $OllamaTaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
}

function Quote-DotEnv([string]$Value) {
    $clean = ($Value -replace "[\r\n]+", " ").Replace("\", "\\").Replace('"', '\"')
    return '"' + $clean + '"'
}

$DataDirEnv = $DataDir.Replace("\", "/")
$EnvFile = Join-Path $AppDir "backend\.env"
@(
    "OPENAI_API_KEY=",
    "AI_BASE_URL=$AiBaseUrl",
    "AI_MODEL=$AiModel",
    "OCR_BASE_URL=$OcrBaseUrl",
    "OCR_MODEL=$OcrModel",
    "AI_TIMEOUT_SECONDS=90",
    "AI_REASONING_EFFORT=medium",
    "AI_TOOLS_ENABLED=true",
    "PUBLIC_BASE_URL=$PublicBaseUrl",
    "PRACTICE_DB_PATH=$DataDirEnv/practice.db",
    "SCHOOL_SESSION_DAYS=30",
    "SERVER_IDENTITY_DIR=$DataDirEnv/identity",
    "SERVER_NAME=$(Quote-DotEnv $ServerName)"
) | Set-Content -Path $EnvFile -Encoding UTF8

Write-Step "[6/7] Configuring Windows startup and firewall"
$BackendDir = Join-Path $AppDir "backend"
$BackendLog = Join-Path $RootDir "backend.log"
$RunBackend = Join-Path $RootDir "run-backend.ps1"
@"
Set-Location "$($BackendDir.Replace('"','""'))"
& "$($VenvPython.Replace('"','""'))" -m app.run_server --host 0.0.0.0 --port $Port *>> "$($BackendLog.Replace('"','""'))"
"@ | Set-Content -Path $RunBackend -Encoding UTF8

$BackendAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$RunBackend`""
$BackendTrigger = New-ScheduledTaskTrigger -AtStartup
$BackendPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$BackendSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $BackendTaskName -Action $BackendAction -Trigger $BackendTrigger -Principal $BackendPrincipal -Settings $BackendSettings -Force | Out-Null

Get-NetFirewallRule -DisplayName "Matrix Smartboard HTTPS" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "Matrix Smartboard HTTPS" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Any | Out-Null
Get-NetFirewallRule -DisplayName "Matrix Smartboard mDNS" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "Matrix Smartboard mDNS" -Direction Inbound -Action Allow -Protocol UDP -LocalPort 5353 -Profile Any | Out-Null

Start-ScheduledTask -TaskName $BackendTaskName

function Test-MatrixServer {
    $previous = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
    try {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
        $response = Invoke-WebRequest -UseBasicParsing -Uri "https://127.0.0.1:$Port/api/status" -TimeoutSec 3
        return $response.StatusCode -eq 200
    } catch {
        return $false
    } finally {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $previous
    }
}

Write-Step "[7/7] Checking server"
$Ready = $false
for ($i = 0; $i -lt 30; $i++) {
    if (Test-MatrixServer) { $Ready = $true; break }
    Start-Sleep -Seconds 2
}

if ($Ready) {
    Write-Output ""
    Write-Output "Matrix Smartboard server is ready"
    Write-Output "Port: $Port"
    exit 0
}

Write-Output "Scheduled task state:"
Get-ScheduledTask -TaskName $BackendTaskName -ErrorAction SilentlyContinue | Format-List TaskName, State
if (Test-Path $BackendLog) {
    Write-Output "Backend log:"
    Get-Content -Path $BackendLog -Tail 80
}
Write-Error "Matrix Smartboard did not become ready"
exit 4
