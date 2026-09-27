# Security checklist (live server)

From the full review of 2026-09-25 (`docs/review/2026-09-full-review.md`) and the security review of 2026-09-26. Items marked **fixed** are in the code. The others must be done on the server or remain open.

## Server
- [ ] **HTTPS.** Either give the API the certificate (`TLS_PFX_FILE` + `TLS_PFX_PASSPHRASE`), or put an HTTPS reverse proxy in front: on the same server with `HOST=127.0.0.1` and `TRUST_PROXY=true`, or on another machine with `TRUST_PROXY=<proxy IPs/CIDRs>`. **Fixed (2026-09-26):** `TRUST_PROXY=true` with any other `HOST` refuses to start (anyone could fake their address and "https"). The API serves the **built** web app (`SERVE_WEB=true`, `npm run build`), never the Vite dev server. Cookies are `secure`, and HSTS is sent. **Built (2026-09-25):** a production server refuses to start without HTTPS. What remains is IT supplying the certificate (production-setup.md).
- [ ] `.env`:
  - `NODE_ENV=production`
  - `ALLOW_TEST_LOGIN=false`
  - `ALLOW_VIEW_AS=false`
  - a 32+ byte `SESSION_SECRET`
  - a separate `SETTINGS_ENCRYPTION_KEY` kept in the IT vault
  - `DB_ENCRYPT=true`, `DB_TRUST_SERVER_CERT=false` (SQL Server certificate trusted by the server)
  - `AD_URL=ldaps://…`

  The server refuses to start in production with a test switch on, without HTTPS, with an unencrypted database connection or with `ldap://`, and refuses to submit purchase orders to the SAP simulator. `DB_TRUST_SERVER_CERT=true` logs a warning at start. **Fixed.**
- [ ] The Windows service account running the API has read/write access only to the attachments folder and the logs.
- [ ] SQL login with the least rights needed: `db_datareader`, `db_datawriter` and EXECUTE. Migrations run under a separate deploy login.

## Accounts and roles
- [ ] Registered users only; demo accounts are unused in production because View as is off.
- [ ] Administrators: at least 2, at most 3, named.
- [ ] **Operations status → Users and roles** shows no separation-of-duties conflicts.
  - The server itself refuses accepting your own demand or your own handoff, and deciding your own change request. **Fixed.**
- [ ] Delegated administration: a non-admin with `users.add`, `users.edit`, `users.companies.edit` or `security.roles.edit` cannot give an administrator role, keys or companies they do not hold, or change themselves. **Fixed.**
- [ ] The AD search account is a service account from IT (backlog 2), with a password that does not expire silently.

## Connections
- [ ] **AD:** `ldaps://` with certificate checking on. On a production server `ldap://` and *allow self-signed* are refused on save and before every bind, so IT must install the company CA before go-live. **Fixed (2026-09-26).**
- [ ] A saved AD or SAP password is never sent to a changed address or account; it must be entered again. **Fixed.**
- [ ] **SAP:** a technical user with rights limited to the OData services used (materials, suppliers, purchase orders, and the PO creation service with the ZCON adapter).

## Data
- [ ] Company scope: users see only their companies. The negative-authorization DB test covers 34 procedures. Purchase orders synced from SAP are limited to the reader's companies too (2026-09-26). **Fixed and tested.**
- [ ] Attachments are limited by type and size (Configuration → workflow settings), stored by hash, and every download is logged. The content must match the type (a renamed `.exe` is refused). The session and the declared size are checked before the upload body is read, and only the upload route accepts a raw body. **Fixed (2026-09-26).**
- [ ] Unexpected errors reach the browser only as an error id (`E-…`); the full error is in the log under that id. **Fixed (2026-09-26).**
- [ ] Security changes (roles, role permissions, users, their roles and companies, deletes) write their audit row in the same transaction: no change without its audit row. Sign-in events stay best-effort. **Fixed (2026-09-26).**
- [ ] The web app is served with a Content-Security-Policy (scripts only from the server, no framing). **Fixed (2026-09-26).**
- [ ] **Open:** malware scan of uploaded files (use a server AV that scans the attachments folder on write).

## Open review items (accepted risks until fixed; see the backlog)
- Sessions last 30 days (user decision 2026-09-26, was 10 h). **Revocable since 2026-09-26 (migration 0030, `app.User.SessionVersion`):** **signing out signs the user out on every device**, and disabling, archiving/deleting a user or changing their roles or companies ends all their sessions. An administrator who changes their own roles or companies stays signed in on the current browser only. On shared PCs, users must still sign out.
- The login rate limit (10 a minute per address, 5 a minute per username; refusals audited as `login.throttled`) is in memory: it restarts with the process and is not shared between several API processes.
