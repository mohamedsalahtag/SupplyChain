@echo off
rem Makes Supply Chain start automatically when you log in to Windows
rem (a minimized shortcut in your Startup folder). Undo with remove-autostart.bat.
setlocal
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Supply Chain.lnk"
powershell -NoProfile -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK);" ^
  "$s.TargetPath = '%~dp0start-supplychain.bat';" ^
  "$s.Arguments = '/atlogon';" ^
  "$s.WorkingDirectory = '%~dp0';" ^
  "$s.WindowStyle = 7;" ^
  "$s.Description = 'Start the Supply Chain app';" ^
  "$s.Save()"
if exist "%LNK%" (
  echo Done. Supply Chain will start each time you log in to Windows.
) else (
  echo Could not create the Startup shortcut.
)
pause
