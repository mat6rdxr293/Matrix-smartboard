Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# The board reads this output as UTF-8; the console default (an OEM code page) garbles Russian
# error messages from Windows.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
$OutputEncoding = New-Object System.Text.UTF8Encoding $false

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

$PythonVersion = "3.13.5"
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }

# Straight to stdout: a function whose result is used cannot print with Write-Output, and the
# board shows each line as it arrives.
function Say([string]$Text) {
    [Console]::Out.WriteLine($Text)
    [Console]::Out.Flush()
}

function Format-MB([double]$Bytes) { return "{0:N0} MB" -f ($Bytes / 1MB) }

# Downloads with a line of progress every few seconds, so a long download over SSH is visibly alive.
# A dropped connection is resumed where it stopped (HTTP Range), up to a few times.
function Get-FileWithProgress([string]$Url, [string]$Path, [string]$Label) {
    Add-Type -AssemblyName System.Net.Http
    Remove-Item -Force $Path -ErrorAction SilentlyContinue
    $done = [long]0
    $total = $null
    $attempts = 8
    for ($attempt = 1; $attempt -le $attempts; $attempt++) {
        $client = New-Object System.Net.Http.HttpClient
        $client.Timeout = [TimeSpan]::FromMinutes(90)
        try {
            $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $Url)
            if ($done -gt 0) { $request.Headers.Range = New-Object System.Net.Http.Headers.RangeHeaderValue($done, $null) }
            $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            if (-not $response.IsSuccessStatusCode) { throw "HTTP $([int]$response.StatusCode)" }
            if ($done -gt 0 -and [int]$response.StatusCode -ne 206) {
                # The server ignored the range: start over.
                Say "Server cannot resume ${Label}; starting the download again"
                $done = [long]0
                Remove-Item -Force $Path -ErrorAction SilentlyContinue
            }
            if (-not $total) {
                $length = $response.Content.Headers.ContentLength
                if ($length) { $total = $done + $length }
            }
            $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            if ($stream.CanTimeout) { $stream.ReadTimeout = 60000 }
            $output = New-Object IO.FileStream($Path, [IO.FileMode]::Append, [IO.FileAccess]::Write)
            try {
                $buffer = New-Object byte[] 1048576
                $tick = [Diagnostics.Stopwatch]::StartNew()
                while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $output.Write($buffer, 0, $read)
                    $done += $read
                    if ($tick.Elapsed.TotalSeconds -ge 5) {
                        $tick.Restart()
                        if ($total) { Say "Downloading ${Label}: $(Format-MB $done) of $(Format-MB $total) ($([int](100 * $done / $total))%)" }
                        else { Say "Downloading ${Label}: $(Format-MB $done)" }
                    }
                }
            } finally {
                $output.Dispose()
                $stream.Dispose()
            }
            if ($total -and $done -lt $total) { throw "connection closed at $(Format-MB $done) of $(Format-MB $total)" }
            Say "Downloaded ${Label}: $(Format-MB $done)"
            return
        } catch {
            if ($attempt -ge $attempts) { throw "$Label download failed after $attempts attempts: $($_.Exception.Message)" }
            Say "Download of $Label interrupted at $(Format-MB $done): $($_.Exception.Message). Resuming in 5 s (attempt $($attempt + 1) of $attempts)"
            Start-Sleep -Seconds 5
        } finally {
            $client.Dispose()
        }
    }
}

# Waits for an installer, saying every 15 s that it is still running, and gives up after a limit
# instead of hanging the whole setup.
function Wait-Installer([Diagnostics.Process]$Process, [string]$Label, [int]$TimeoutMinutes) {
    # Without the handle taken early, Windows PowerShell reports no exit code for such a process.
    $null = $Process.Handle
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while (-not $Process.WaitForExit(15000)) {
        if ($clock.Elapsed.TotalMinutes -ge $TimeoutMinutes) {
            try { $Process.Kill() } catch {}
            throw "$Label did not finish in $TimeoutMinutes minutes"
        }
        Say "$Label still installing ($([int]$clock.Elapsed.TotalSeconds) s)"
    }
    return $Process.ExitCode
}

# Fallback only: winget often waits forever in an SSH session (no desktop, store agreements).
function Install-WingetPackage([string]$Id) {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    $wingetPath = if ($winget) { $winget.Source } else { Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\winget.exe" }
    if (-not (Test-Path $wingetPath)) {
        Write-Error "winget is required to install missing Windows prerequisites automatically."
        exit 3
    }
    Say "Trying winget for $Id"
    $process = Start-Process -FilePath $wingetPath -PassThru -NoNewWindow -ArgumentList @(
        "install", "--id", $Id, "-e", "--silent", "--scope", "machine",
        "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"
    )
    $code = Wait-Installer $process "winget $Id" 20
    if ($code -ne 0) {
        Write-Error "winget failed to install $Id (exit $code)"
        exit 3
    }
}

function Install-Python {
    $installer = Join-Path $env:TEMP "python-$PythonVersion-$Arch.exe"
    try {
        Get-FileWithProgress "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-$Arch.exe" $installer "Python $PythonVersion"
        Write-Output "Running the Python installer (all users, silent)"
        $process = Start-Process -FilePath $installer -PassThru -ArgumentList @(
            "/quiet", "InstallAllUsers=1", "PrependPath=1", "Include_test=0", "Include_launcher=1", "Include_doc=0"
        )
        $code = Wait-Installer $process "Python" 15
        if ($code -ne 0 -and $code -ne 3010) { throw "Python installer exit code $code" }
    } catch {
        Write-Output "Direct Python install failed: $($_.Exception.Message)"
        Install-WingetPackage "Python.Python.3.13"
    } finally {
        Remove-Item -Force $installer -ErrorAction SilentlyContinue
    }
}

Write-Step "[1/7] Checking Windows prerequisites"
$Python = Find-Python
if (-not $Python) {
    Write-Output "Python 3.11+ not found; installing Python $PythonVersion from python.org"
    Install-Python
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
        (Join-Path $RootDir "ollama\ollama.exe"),
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
        # The standalone build: no installer, no tray app, a fixed place the service can run from.
        Write-Output "Ollama not found; downloading the standalone build from ollama.com"
        $OllamaZip = Join-Path $env:TEMP "ollama-windows-$Arch.zip"
        try {
            Get-FileWithProgress "https://ollama.com/download/ollama-windows-$Arch.zip" $OllamaZip "Ollama"
            Write-Output "Unpacking Ollama"
            $OllamaDir = Join-Path $RootDir "ollama"
            if (Test-Path $OllamaDir) { Remove-Item -Recurse -Force $OllamaDir }
            Expand-Archive -Path $OllamaZip -DestinationPath $OllamaDir -Force
        } catch {
            Write-Output "Direct Ollama install failed: $($_.Exception.Message)"
            Install-WingetPackage "Ollama.Ollama"
        } finally {
            Remove-Item -Force $OllamaZip -ErrorAction SilentlyContinue
        }
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
    $TaskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 20 -RestartInterval (New-TimeSpan -Seconds 5)
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
$BackendSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 20 -RestartInterval (New-TimeSpan -Seconds 5)
Register-ScheduledTask -TaskName $BackendTaskName -Action $BackendAction -Trigger $BackendTrigger -Principal $BackendPrincipal -Settings $BackendSettings -Force | Out-Null

@{
    port = $Port
    installedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
} | ConvertTo-Json | Set-Content -Path (Join-Path $RootDir "server.json") -Encoding UTF8

try {
    $headers = @{ "User-Agent" = "Matrix-Smartboard-Installer"; "Accept" = "application/vnd.github+json" }
    $latest = Invoke-RestMethod -UseBasicParsing -Headers $headers -Uri "https://api.github.com/repos/mat6rdxr293/Matrix-smartboard/commits/main" -TimeoutSec 10
    if ($latest.sha) {
        Set-Content -Path (Join-Path $AppDir ".matrix-version") -Value ([string]$latest.sha) -Encoding ASCII
    }
} catch {}

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
