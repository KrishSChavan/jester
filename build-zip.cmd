@echo off
REM Runs build-zip.ps1 without touching PowerShell's execution policy.
REM
REM Windows ships PowerShell as Restricted, so a bare `.\build-zip.ps1` fails
REM with "cannot be loaded because running scripts is disabled on this system".
REM -ExecutionPolicy Bypass applies to this one process only, so the machine's
REM setting is left exactly as it was.
REM
REM Run it from a terminal — cmd, PowerShell or Git Bash. Deliberately no
REM `pause` on the way out: every way of telling a double-click apart from a
REM scripted `cmd /c` also matches the scripted case, and a wrapper that can
REM hang someone's build script is worse than one whose window closes too fast.
REM
REM Arguments pass straight through:
REM
REM   build-zip.cmd
REM   build-zip.cmd -Flat -Versioned

setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-zip.ps1" %*
exit /b %ERRORLEVEL%
