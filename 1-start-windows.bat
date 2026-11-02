@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PYTHON_CMD="
for %%V in (3.13 3.12 3.11) do (
    py -%%V -c "import sys" >nul 2>&1
    if not errorlevel 1 (
        set "PYTHON_CMD=py -%%V"
        goto :python_found
    )
)

python -c "import sys; assert sys.version_info >= (3, 11)" >nul 2>&1
if not errorlevel 1 (
    set "PYTHON_CMD=python"
    goto :python_found
)

echo [ERROR] Python 3.11+ was not found.
echo Install Python 3.11+ and Node.js LTS, then run this file again.
echo Windows package manager commands:
echo   winget install Python.Python.3.13
echo   winget install OpenJS.NodeJS.LTS
pause
exit /b 2

:python_found
%PYTHON_CMD% scripts\start_project.py %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo Matrix Smartboard launcher failed with code %EXIT_CODE%.
    pause
)
exit /b %EXIT_CODE%
