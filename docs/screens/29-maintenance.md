# 29 · Maintenance: start over, delete a user, the project logo, session length

**Status:** Built 2026-09-26 (asked by the user the same day): waiting for acceptance.

## 1 · Configuration → Maintenance → Start over
**Purpose:** on a test server, delete every workflow record so testing can begin again from a clean slate.

- **Who:** `configuration.purge` (Administration; no seeded role holds it — administrators do).
- **Screen:** what will be deleted (demands, change requests, merges, RFQs, quotes, awards, handoffs, PO drafts, work items, comments, attachments, history events — with counts) and what is kept. **Purge all workflow data…** opens a window where the word **PURGE** must be typed.
- **Deleted:** every demand and everything that came from it — weeks, lines, container groups, versions, the quantity ledger and its history, change requests and holds, merges, RFQs, quotes, awards, acknowledgements, shipping terms, handoffs, PO drafts, SAP submissions and the simulator's POs, work items, domain events, comments, attachments (rows and files), the notification outbox and the command log. Number sequences restart: the next demand is **D-000001**.
- **Kept:** users, roles and permissions, companies and user companies, reason codes, origins and supplier origins, shipping-term lists, every setting and connection, the SAP copies (materials, suppliers, purchase orders, purchase history), the system work items (*Sync failed*, *Origins to map*), the security audit log.
- **Rules:** one transaction — everything or nothing. The three history triggers (versions, comments, attachments) are switched off inside that transaction only and back on at its end. Attachment files are removed after the commit (a file left behind is harmless). **Refused on a production server** (`NODE_ENV=production`), in the API and on the screen. Audited as `data.purge` with the counts.

## 2 · Users → Delete user
**Purpose:** remove a user from the app.

- **Who:** `users.delete` (Administration → Users). Refused for yourself, for the demo accounts (View as needs them), for an administrator unless you are one, and when it would leave no active administrator.
- **Screen:** in the user drawer, a **Delete user** area says first which ending applies:
  - **No records** → the account, its roles, companies and preferences are deleted outright (`user.delete`).
  - **On records** (a demand they created, a quote they recorded, a comment …; listed with counts) → the account is **archived**: removed from the Users list, cannot sign in, roles and companies removed, username freed (`deleted.<id>.<username>`) so the same person can be registered again. The display name stays, so history still says who did what (`user.archive`). Business records are never deleted, and a shared "deleted user" would make them lie about who acted.
- **Data:** migration **0029** adds `app.User.DeletedAt`. Where a user appears is read from the database catalog (every foreign key to `app.User`) plus the provenance columns without a key (events, comments, attachments, quantity history, versions, work items), so a new table is never missed.

## 3 · The project logo
The logo chosen in Configuration → General on 2026-09-26 is saved in the project as `apps/web/public/logo.ico` and is the **built-in logo**: the browser tab, the header and the sign-in page use it whenever no other icon is saved. Configuration → General still changes the icon at any time; **Use the project logo** goes back to this file. To change the built-in logo itself, replace that file.

## 4 · Session length
Sessions last **30 days** (was 10 hours). Signing out ends a session at once; disabling or deleting a user ends it on their next request, because users are reloaded every time.

## Tests
`apps/api/test/db/po.spec.ts`: delete outright, archive with the username freed and the name kept, refusals; the purge after a full demand → SAP PO chain (every workflow table empty, users and master data kept, invariants pass, the next demand is D-000001, the triggers are back on). `e2e/maintenance.spec.ts`: both screens open and confirm — without purging or deleting anything on the dev database.
