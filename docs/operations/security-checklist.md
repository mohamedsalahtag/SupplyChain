# Security checklist (live server)

From the full review of 2026-09-25 (`docs/review/2026-09-full-review.md`). Items marked **fixed** are in the code. The others must be done on the server or remain open.

## Server
- [ ] **HTTPS.** Either give the API the certificate (`TLS_PFX_FILE` + `TLS_PFX_PASSPHRASE`), or put an HTTPS reverse proxy in front with `HOST=127.0.0.1` and `TRUST_PROXY=true`. The API serves the **built** web app (`SERVE_WEB=true`, `npm run build`), never the Vite dev server. Cookies are `secure`, and HSTS is sent. **Built (2026-09-25):** a production server refuses to start without HTTPS. What remains is IT supplying the certificate (production-setup.md).
- [ ] `.env`:
  - `NODE_ENV=production`
  - `ALLOW_TEST_LOGIN=false`
  - `ALLOW_VIEW_AS=false`
  - a 32+ byte `SESSION_SECRET`
  - a separate `SETTINGS_ENCRYPTION_KEY` kept in the IT vault

  The server refuses to start in production with a test switch on or without HTTPS, and refuses to submit purchase orders to the SAP simulator. **Fixed.**
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
- [ ] **AD:** use `ldaps://` with certificate checking on (untick *allow self-signed*) once IT provides the CA. Unsaved settings already check certificates in production. **Fixed.**
- [ ] A saved AD or SAP password is never sent to a changed address or account; it must be entered again. **Fixed.**
- [ ] **SAP:** a technical user with rights limited to the OData services used (materials, suppliers, purchase orders, and the PO creation service with the ZCON adapter).

## Data
- [ ] Company scope: users see only their companies. The negative-authorization DB test covers 34 procedures. **Fixed and tested.**
- [ ] Attachments are limited by type and size (Configuration → workflow settings), stored by hash, and every download is logged.
- [ ] **Open:** malware scan of uploaded files (use a server AV that scans the attachments folder on write).

## Open review items (accepted risks until fixed; see the backlog)
- Sessions can't be revoked before they expire (10 h). Disabling a user takes effect at once, because users are reloaded per request.
- The login rate limit is per address only, and in memory.
- An upload body is read before the session is checked (up to the size limit).
- Purchase orders synced from SAP (read-only history) are visible across companies to holders of `purchaseOrders.open`.
