@echo off
rem Starts the Supply Chain app: API on :4300, web on http://localhost:5300
rem Runs as the logged-in Windows user (the database uses that login).
rem Started at logon by the shortcut that install-autostart.bat creates.
title Supply Chain
cd /d "%~dp0"

rem Already running? Then do nothing.
netstat -ano | findstr /r /c:":4300 .*LISTENING" >nul
if not errorlevel 1 (
  echo Supply Chain is already running on http://localhost:5300
  timeout /t 5 >nul
  exit /b 0
)

rem After a restart, give the network (SQL Server, SAP) time to come up.
if /i "%~1"=="/atlogon" timeout /t 30 /nobreak >nul

if not exist logs mkdir logs
echo %date% %time% Starting Supply Chain >> "logs\app.log"
echo Supply Chain is starting. Open http://localhost:5300 - keep this window open.
echo Log: %~dp0logs\app.log
call npm run dev >> "logs\app.log" 2>&1
