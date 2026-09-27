# Production server (live since 2026-09-27)

| Item | Value |
|---|---|
| Address | **https://KSAJEDSVSCM001.sharbatlyfruit.com/** (192.168.3.24), health: `/trpc/health` |
| Server | KSAJEDSVSCM001, Windows Server 2022, **no internet** (updates are copied from a PC, see below) |
| App folder | `C:\SupplyChain` (code, built web app, `node_modules`, `.env`), logs `C:\SupplyChain\logs\app.log` |
| Attachments | `C:\SupplyChainData\attachments` — back this folder up with the database |
| Runs as | Task Scheduler task **SupplyChain**, at startup, as `NT AUTHORITY\NETWORK SERVICE` (restarts every minute on failure). No password to keep up to date |
| Database | `supplychain_prod` on KSAJEDSVSQL003, Windows login `SHARBATLYFRUIT\KSAJEDSVSCM001$` (the server's machine account) = db_owner of that database only. Query Store on |
| Node | 24.15.0 + ODBC Driver 18 + VC++ runtime (installers in `C:\Temp\sc-install`) |
| HTTPS | Company-CA certificate "SupplyChain app" (WebServer template, request 3210), **expires 2028-09-26**, in `C:\certs\supplychain.pfx`; its password is in `.env` and `C:\certs\pfx-pass.txt`. `C:\certs` is readable only by admins, SYSTEM and the app |
| Firewall | Inbound TCP 443, domain + private profiles |

## How it was set up
- `supplychain_prod` was created empty and migrated, then **configuration and users** were copied from the dev database (roles, permissions, users, user roles/companies/preferences, companies, Incoterms, ports, payment terms, reason codes, origins, settings) together with the SAP master data and sync history (materials, suppliers, purchasing orgs, SAP purchase orders, supplier origins, purchase history). No demand, RFQ, award, handoff, PO or audit record was copied.
- Saved secrets (AD search account, SAP password) were re-encrypted with the production `SETTINGS_ENCRYPTION_KEY`. **Keep a copy of that key in the IT vault** — without it the saved passwords can't be read after a rebuild. `SESSION_SECRET` is also new, so dev sign-ins don't work here.
- Production AD setting: `ldaps://KSAJEDSVADC005.sharbatlyfruit.com:636` (the certificate names the host, not 192.168.2.19), certificate checked. SAP: certificate checked. Node trusts the company CA through `--use-system-ca` (`apps/api/scripts/start.mjs`).
- `DB_TRUST_SERVER_CERT=true`: the connection is encrypted, but KSAJEDSVSQL003 has a self-signed certificate. When IT installs a company-CA certificate on SQL Server, set it to `false` and restart.

## Publishing an update
From the developer PC (admin on the server, sysadmin on KSAJEDSVSQL003):
```powershell
pwsh C:\SupplyChain\deploy\publish-production.ps1
```
It runs typecheck, unit tests and the build; takes a copy-only backup of `supplychain_prod` into the SQL Server backup folder; applies migrations; stops the task; mirrors the folder (the server's `.env`, logs and attachments are kept); starts the task; waits for the health check. **Commit what you publish** so the server always matches a commit.

## Day to day
- Restart: `Invoke-Command -ComputerName KSAJEDSVSCM001.sharbatlyfruit.com { Stop-ScheduledTask SupplyChain; Start-ScheduledTask SupplyChain }` (the publish script also stops leftover node processes).
- Logs: `\\KSAJEDSVSCM001.sharbatlyfruit.com\C$\SupplyChain\logs\app.log`.
- Backups: the database is in FULL recovery — the DBA must schedule full **and log** backups (otherwise the log grows without limit), plus the attachments folder.
