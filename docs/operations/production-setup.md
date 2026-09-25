# Production server setup

This guide takes a Windows server from nothing to the app running over HTTPS. It is written for IT. Go through the go-live gate in [cutover.md](cutover.md) before real users sign in.

## 1. What the server needs
| Item | Detail |
|---|---|
| Windows Server | 2019 or later, joined to the domain |
| Node.js | 24 LTS (the version the app is tested on) |
| Git | To take the code from `https://github.com/mohamedsalahtag/SupplyChain.git` |
| ODBC Driver 18 for SQL Server | The database driver |
| SQL Server | The production database (2016 or later), empty, with a login for the app |
| Network | To SQL Server, the AD server (LDAPS 636) and the SAP gateway |
| TLS certificate | For the server's name (e.g. `supplychain.sharbatlyfruit.com`), issued by the company CA or a public CA, as a `.pfx` with its password |
| Service account | A domain account that runs the app. The database uses its Windows login if `DB_USER` is empty. |

## 2. Install
Run in PowerShell as the service account's administrator:
```powershell
git clone https://github.com/mohamedsalahtag/SupplyChain.git C:\SupplyChain
cd C:\SupplyChain
npm ci
copy .env.example .env    # then edit it, next step
```

## 3. `.env` on the server
Required values:
```ini
DB_SERVER=<sql server>
DB_NAME=supplychain
SETTINGS_ENCRYPTION_KEY=<32 random bytes, base64 — keep a copy in the IT vault>
SESSION_SECRET=<32 random bytes, base64, different from the key>
BOOTSTRAP_ADMIN=<AD username of the first administrator>
NODE_ENV=production
SERVE_WEB=true
API_PORT=443
TLS_PFX_FILE=C:\certs\supplychain.pfx
TLS_PFX_PASSPHRASE=<the pfx password>
ALLOW_TEST_LOGIN=false
ALLOW_VIEW_AS=false
ATTACHMENTS_DIR=D:\SupplyChainData\attachments
```
To generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

With `NODE_ENV=production`, the app **refuses to start** if a test switch is on or if HTTPS is missing, so a mistake is caught at start, not in use.

**Behind a reverse proxy instead** (IIS ARR or nginx already terminating HTTPS): set `HOST=127.0.0.1`, `API_PORT=4300` and `TRUST_PROXY=true`, and leave the `TLS_*` values empty. The proxy forwards everything to `http://127.0.0.1:4300`.

## 4. Database and build
```powershell
npm run db:migrate     # creates / updates every table (safe to re-run)
npm run build          # builds the web app into apps\web\dist
```

## 5. Run as a Windows service
Use NSSM (the Non-Sucking Service Manager, a single exe) or Task Scheduler.
- **NSSM:**
  ```powershell
  nssm install SupplyChain "C:\Program Files\nodejs\npm.cmd" start
  nssm set SupplyChain AppDirectory C:\SupplyChain
  nssm set SupplyChain ObjectName DOMAIN\svc-supplychain <password>
  nssm set SupplyChain AppStdout C:\SupplyChain\logs\app.log
  nssm set SupplyChain AppStderr C:\SupplyChain\logs\app.log
  nssm start SupplyChain
  ```
- **Task Scheduler (no extra tool):** a task "At startup", run whether the user is logged on or not, as the service account, action `C:\SupplyChain\start-production.bat`.

Open the firewall for TCP 443. Browse to `https://<server name>/`. The health check at `https://<server name>/trpc/health` must say `connected`.

## 6. First configuration (as the bootstrap administrator)
1. **Users:** add the users, then roles **and companies**.
2. **Configuration:**
   - SAP connection → Test
   - run the three syncs
   - Companies (plant, purchasing org and group)
   - Shipping terms
   - Reason codes
   - Workflow settings
3. **Configuration → SAP purchase orders:** enter the PO API (base URL, create and lookup paths, the SAP field for the portal reference, user and password). Then **Test lookup**, then switch to **PO API**. Until then the server refuses to submit purchase orders.
4. **Operations status:** everything green.

## 7. Updating to a new version
```powershell
nssm stop SupplyChain
cd C:\SupplyChain
git pull
npm ci
npm run db:migrate
npm run build
nssm start SupplyChain
```
Take a database backup before `db:migrate`. Nothing in flight is lost: the SAP outbox picks up where it stopped, and anything that was being sent is looked up in SAP first.

## 8. UAT / test server
Set up the same way, with its own database. There you may set `ALLOW_SAP_STUB=true` to rehearse with the SAP simulator, and `ALLOW_VIEW_AS=true` for trainers. These only take effect without `NODE_ENV=production`, except `ALLOW_SAP_STUB`, which is allowed there on purpose.
