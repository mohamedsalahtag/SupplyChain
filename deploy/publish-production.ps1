# Publishes this PC's C:\SupplyChain to the production server KSAJEDSVSCM001 (docs/operations/production-server.md).
# The server has no internet: the code, the built web app and node_modules are copied from here.
# Run from this PC in PowerShell 7 as a user who is admin on the server and sysadmin on KSAJEDSVSQL003:
#   pwsh C:\SupplyChain\deploy\publish-production.ps1
# Steps: typecheck + unit tests + build → copy-only backup of supplychain_prod → migrations → stop app → copy → start → health.
$ErrorActionPreference = 'Stop'
$server = 'KSAJEDSVSCM001.sharbatlyfruit.com'
$share = "\\$server\C$\SupplyChain"
$root = 'C:\SupplyChain'
Set-Location $root

Write-Host '1/7 Typecheck, unit tests, build' -ForegroundColor Cyan
npm run typecheck; if ($LASTEXITCODE) { throw 'typecheck failed' }
npm test; if ($LASTEXITCODE) { throw 'unit tests failed' }
npm run build; if ($LASTEXITCODE) { throw 'build failed' }

Write-Host '2/7 Copy-only backup of supplychain_prod (to the SQL Server backup folder)' -ForegroundColor Cyan
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$backup = @"
import { sql } from 'kysely';
import { loadConfig } from '../config.js';
import { createDb } from '../db/db.js';
const db = createDb(loadConfig());
const dir = (await sql<{ Data: string }>``EXEC master.dbo.xp_instance_regread N'HKEY_LOCAL_MACHINE', N'Software\\Microsoft\\MSSQLServer\\MSSQLServer', N'BackupDirectory'``.execute(db)).rows[0].Data;
const file = dir + '\\supplychain_prod-$stamp-before-publish.bak';
await sql.raw("BACKUP DATABASE supplychain_prod TO DISK = N'" + file + "' WITH COPY_ONLY, INIT").execute(db);
console.log('backup: ' + file);
await db.destroy();
"@
$tmp = Join-Path $root 'apps\api\src\scripts\_publish_backup_tmp.mts'
Set-Content $tmp $backup -Encoding utf8
try {
  Push-Location "$root\apps\api"; $env:DB_NAME = 'supplychain_prod'
  npx tsx --env-file=../../.env $tmp; if ($LASTEXITCODE) { throw 'backup failed' }
  Write-Host '3/7 Migrations on supplychain_prod' -ForegroundColor Cyan
  npx tsx --env-file=../../.env src/scripts/migrate.ts; if ($LASTEXITCODE) { throw 'migration failed' }
} finally { Remove-Item Env:DB_NAME -ErrorAction SilentlyContinue; Pop-Location; [IO.File]::Delete($tmp) }

Write-Host '4/7 Stop the app on the server' -ForegroundColor Cyan
Invoke-Command -ComputerName $server -ScriptBlock {
  Stop-ScheduledTask -TaskName SupplyChain
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'cmd.exe'" | Where-Object { $_.CommandLine -like '*SupplyChain*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

Write-Host '5/7 Copy the app (the server keeps its own .env, logs and attachments)' -ForegroundColor Cyan
robocopy $root $share /MIR /SJ /SL /MT:16 /R:1 /W:1 /NFL /NDL /NP `
  /XD .git data logs test-results playwright-report .auth .claude .playwright-mcp `
  /XF .env *.log | Select-Object -Last 6
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

Write-Host '6/7 Start the app' -ForegroundColor Cyan
Invoke-Command -ComputerName $server -ScriptBlock { Start-ScheduledTask -TaskName SupplyChain }

Write-Host '7/7 Health check' -ForegroundColor Cyan
foreach ($i in 1..30) {
  Start-Sleep -Seconds 5
  try { $h = (Invoke-WebRequest "https://$server/trpc/health" -UseBasicParsing -TimeoutSec 5).Content; if ($h -match 'connected') { Write-Host "OK $h" -ForegroundColor Green; exit 0 } } catch {}
}
throw "No healthy answer from https://$server/trpc/health — see \\$server\C$\SupplyChain\logs\app.log"
