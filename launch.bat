@echo off
REM Double-click this file to open the DeepSeek Infra local app window.
REM Uses pythonw so there is no black console window behind the app.
setlocal
cd /d "%~dp0"
where pythonw >nul 2>nul
if %errorlevel%==0 (
    start "" pythonw "%~dp0launch.py"
    goto :eof
)
where pyw >nul 2>nul
if %errorlevel%==0 (
    start "" pyw -3 "%~dp0launch.py"
    goto :eof
)
where python >nul 2>nul
if %errorlevel%==0 (
    start "" /min python "%~dp0launch.py"
    goto :eof
)
echo Python 3.10+ is required. Install it from https://www.python.org/downloads/ then double-click this file again.
pause
