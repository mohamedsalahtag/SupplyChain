@echo off
rem Stops Supply Chain from starting automatically at Windows logon.
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Supply Chain.lnk"
if exist "%LNK%" (
  del "%LNK%"
  echo Removed. Supply Chain will no longer start at logon.
) else (
  echo Supply Chain was not set to start at logon.
)
pause
