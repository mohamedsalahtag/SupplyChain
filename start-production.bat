@echo off
rem Production start of the Supply Chain app (docs/operations/production-setup.md).
rem Needs in .env: NODE_ENV=production, SERVE_WEB=true, HTTPS (TLS_PFX_FILE or TRUST_PROXY=true), test switches off.
rem Run "npm run build" after every update first. Better: install it as a Windows service (see the guide).
title Supply Chain (production)
cd /d "%~dp0"
if not exist logs mkdir logs
echo %date% %time% Starting Supply Chain (production) >> "logs\app.log"
call npm start >> "logs\app.log" 2>&1
