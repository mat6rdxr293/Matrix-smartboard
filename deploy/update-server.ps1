Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RootDir = Join-Path $env:ProgramData "MatrixSmartboard"
$AppDir = Join-Path $RootDir "app"
$Port = 8443
$ConfigPath = Join-Path $RootDir "server.json"
$LogPath = Join-Path $RootDir "update.log"
$RepoZipUrl = "https://github.com/mat6rdxr293/Matrix-smartboard/archive/refs/heads/main.zip"
$RepoCommitUrl = "https://api.github.com/repos/mat6rdxr293/Matrix-smartboard/commits/main"
$BackendTaskName = "Matrix Smartboard Server"


function Wait-MatrixHealth {
    param([int]$Port)
    $previous = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
    try {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
        for ($i = 0; $i -lt 30; $i++) {
            try {
                $response = Invoke-WebRequest -UseBasicParsing -Uri "https://127.0.0.1:$Port/api/status" -TimeoutSec 3
                if ($response.StatusCode -eq 200) { return $true }
            } catch {}
            Start-Sleep -Seconds 2
        }
        return $false
    } finally {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $previous
    }
}

if (Test-Path $ConfigPath) {
    try {
        $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
        if ($cfg.port) { $Port = [int]$cfg.port }
    } catch {}
}

Start-Transcript -Path $LogPath -Append | Out-Null
try {
    Write-Output "[$(Get-Date -Format o)] Matrix Smartboard update started"

    $VersionPath = Join-Path $AppDir ".matrix-version"
    $OldVersion = if (Test-Path $VersionPath) { (Get-Content $VersionPath -Raw).Trim() } else { "" }

    $Headers = @{ "User-Agent" = "Matrix-Smartboard-Server"; "Accept" = "application/vnd.github+json" }
    $Latest = Invoke-RestMethod -UseBasicParsing -Headers $Headers -Uri $RepoCommitUrl -TimeoutSec 10
    $NewVersion = [string]$Latest.sha

    if ($OldVersion -and $NewVersion -and $OldVersion -eq $NewVersion) {
        Write-Output "Already up to date: $OldVersion"
        exit 0
    }

    $TempRoot = Join-Path $env:TEMP ("matrix-smartboard-update-" + [Guid]::NewGuid().ToString("N"))
    $ZipPath = Join-Path $TempRoot "main.zip"
    $ExtractPath = Join-Path $TempRoot "extract"
    $Rollback = Join-Path $RootDir "rollback-source"
    New-Item -ItemType Directory -Force -Path $TempRoot, $ExtractPath | Out-Null

    try {
        Invoke-WebRequest -UseBasicParsing -Uri $RepoZipUrl -OutFile $ZipPath
        Expand-Archive -Path $ZipPath -DestinationPath $ExtractPath -Force
        $SourceDir = Get-ChildItem -Path $ExtractPath -Directory | Select-Object -First 1
        if (-not $SourceDir) { throw "Downloaded repository archive is empty" }

        if (Test-Path $Rollback) { Remove-Item -Recurse -Force $Rollback }
        New-Item -ItemType Directory -Force -Path $Rollback | Out-Null

        $backupArgs = @(
            $AppDir, $Rollback, "/E", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP",
            "/XD", (Join-Path $AppDir ".venv"), (Join-Path $AppDir "backend\app\data"),
            "/XF", ".env"
        )
        & robocopy.exe @backupArgs | Out-Null
        if ($LASTEXITCODE -gt 7) { throw "Could not create rollback copy (robocopy $LASTEXITCODE)" }

        $copyArgs = @(
            $SourceDir.FullName, $AppDir, "/E", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP",
            "/XD", (Join-Path $SourceDir.FullName "backend\app\data"),
            "/XF", ".env"
        )
        & robocopy.exe @copyArgs | Out-Null
        if ($LASTEXITCODE -gt 7) { throw "Could not install new source (robocopy $LASTEXITCODE)" }

        $VenvPython = Join-Path $AppDir ".venv\Scripts\python.exe"
        & $VenvPython -m pip install -q -r (Join-Path $AppDir "backend\requirements.txt")
        if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed" }

        if ($NewVersion) { Set-Content -Path $VersionPath -Value $NewVersion -Encoding ASCII }

        Stop-ScheduledTask -TaskName $BackendTaskName -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 600
        Start-ScheduledTask -TaskName $BackendTaskName

        if (Wait-MatrixHealth -Port $Port) {
            Write-Output "Update successful: $NewVersion"
            if (Test-Path $Rollback) { Remove-Item -Recurse -Force $Rollback -ErrorAction SilentlyContinue }
            exit 0
        }

        Write-Output "Health check failed. Rolling back."
        $restoreArgs = @(
            $Rollback, $AppDir, "/E", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP",
            "/XD", (Join-Path $Rollback "backend\app\data"),
            "/XF", ".env"
        )
        & robocopy.exe @restoreArgs | Out-Null
        if ($LASTEXITCODE -gt 7) { throw "Rollback copy failed (robocopy $LASTEXITCODE)" }

        & $VenvPython -m pip install -q -r (Join-Path $AppDir "backend\requirements.txt")
        if ($OldVersion) { Set-Content -Path $VersionPath -Value $OldVersion -Encoding ASCII }
        Stop-ScheduledTask -TaskName $BackendTaskName -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 600
        Start-ScheduledTask -TaskName $BackendTaskName

        if (Wait-MatrixHealth -Port $Port) {
            Write-Output "Rollback successful: $OldVersion"
            exit 4
        }
        throw "Rollback did not restore server health"
    } finally {
        Remove-Item -Recurse -Force $TempRoot -ErrorAction SilentlyContinue
    }
} finally {
    try { Stop-Transcript | Out-Null } catch {}
}
