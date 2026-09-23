# Supply Chain (new, experimental)

A from-scratch rebuild. The previous application failed: unstable workflows, business rules duplicated between server and UI, hidden automatic status changes, two screens for the same job, and screens full of functions nobody asked for. **Every design choice is checked against "would this repeat an old failure?"**

## Hard rules

1. **Build only what the approved screen spec says.** Specs live in `docs/screens/`. Anything else goes to `docs/backlog.md`, never into the code.
2. **One place changes a status.** When workflows arrive, a single workflow module owns every status transition; the server returns the allowed actions per record and the UI only renders them. The UI never decides business rules.
3. **One screen per job.** No second way to do the same thing.
4. **No hidden automatic actions.** Every automatic step appears in the screen's process flow and is logged.
5. **Thin routes, logic in services.** No file over ~400 lines.
6. **Nothing from the old application** — no code, layout, settings or data. It is a source of ideas only. Never write to the old repo or its database.
7. **Done means:** spec met, smoke test passes, the user has tried and accepted the screen.

## How a screen is made

1. Discuss purpose, users, the main path, and what is explicitly out of scope.
2. Write a short Mermaid process flow; check every step has a way in and out, an owner, a failure outcome, and a concurrent-edit outcome.
3. Clickable HTML mockup (Ant Design look) → revise until approved.
4. Record the approved spec in `docs/screens/NN-name.md`.
5. Build DB table + API procedure + screen for exactly that spec.
6. Smoke test, user acceptance.

## Stack

- `apps/api` — Fastify + tRPC + zod + Kysely (MSSQL via ODBC / msnodesqlv8) + pino. Port 4300.
- `apps/web` — Vite + React + **Ant Design 5** + TanStack Query (tRPC client) + React Router. Port 5300 (proxies `/trpc` to the API).
- `packages/shared` — types and constants shared by both sides.
- `db/migrations` — numbered `.sql` files, applied in order by `npm run db:migrate`; `GO` separates batches.

## Database notes

- The API connects through ODBC (`msnodesqlv8`) with the Windows login of whoever runs it; see `apps/api/src/db/odbcDialect.ts`.
- **msnodesqlv8 returns IDENTITY columns as strings.** Wrap them in `Number()` where they are read.
- **SAP (OData):** `apps/api/src/sap/odata.ts` serves both v2 (materials, business partners: `d.results`) and v4 (purchase orders: `value`). SAP returns at most **5,000 rows per page**, so always page. Every value put into a `$filter` is validated first (codes `^Z[A-Z0-9]{1,9}$`, dates `YYYY-MM-DD`).
- **Every SAP sync** uses `modules/sync/`: `launchSync` (background start, one run per source), `finishRun` (result row), `sync.status` (UI), `codeList` ("load the list from SAP, then choose"). Writes are keyed upserts (`MERGE` from `OPENJSON`), so pressing Sync again never duplicates. In the UI, use `SyncCard` and `CodeChoiceCard`.
- Store timestamps with `SYSUTCDATETIME()` on the database side, never `new Date()` from Node. Send them to the UI as ISO strings.

## UI conventions

- **Compact and dense.** Screens will carry many details. The theme in `apps/web/src/main.tsx` uses antd's `compactAlgorithm` for spacing, `componentSize="small"` and tight table rows. Don't override it per screen.
- **Font size, site name and icon are app-wide settings** (Configuration → Appearance / General; `ui.appearance` and `ui.branding` in `app.Setting`; default font 13px). The font number is the real on-screen size: `keepChosenFontSize` stops the compact algorithm from shrinking text. Never hard-code font sizes, the site name or the icon in screens.
- **Every table is an `AppTable`** (`apps/web/src/components/AppTable.tsx`) with `useTablePrefs('<table-key>')`. That gives 25 / 50 / 100 rows per page (default 25) and a Columns chooser. Both are saved **per user in `app.UserPreference`**, so they survive restarts and change only when the user changes them. Every column needs a stable `key`, a text `title` and a numeric `width`.
- **No table ever scrolls sideways.** `AppTable` turns column widths into shares of the page width (`tableLayout="fixed"`), and long text ends in "…" with the full text on hover. Don't pass `scroll` or `fixed` columns. Columns that should start hidden go in `useTablePrefs('<table>', defaultHidden)`. "Default columns" in the chooser brings them back. API list inputs accept only `TABLE_PAGE_SIZES` from `@supplychain/shared`.
- **Every filter dropdown is a `MultiFilter`** (`apps/web/src/components/MultiFilter.tsx`): multi-select, searchable, clearable. API filter inputs are arrays, matched with `in`.
- Configuration is one page with tabs (`?tab=general|appearance|sap|sync|suppliers|po|ad`), each shown only with its permission. A new settings area gets its own tab.
- Page titles are `Typography.Title level={5}`. Tables are `size="small"` and `bordered`. Record details open in a read-only `Drawer`.

## Security

- **Sign-in is Active Directory** (`apps/api/src/auth/`). The user's own password is checked by binding to AD over LDAPS. Only users registered on the Users page can sign in. Sessions are an httpOnly, SameSite=Strict cookie holding the user id; the user and their permissions are reloaded from the DB on every request.
- **Every screen and button is in the permission catalogue** (`packages/shared/src/permissions.ts`). The Security page shows exactly that list. A new screen or button **must** add its entry there.
- **Every procedure declares a catalogue key** with `procedure.meta({ permission: P.xxx })`, or `SIGNED_IN` for things any signed-in user needs (own preferences, theme). `publicProcedure` is only for sign-in and the health check. `apps/api/src/trpc/trpc.spec.ts` fails if a procedure uses an unknown key or is public without being on its short list.
- The Administrator role (`IsAdmin`) holds every permission, including future ones. Nobody can disable themselves or remove their own admin role, and the last active admin can't be removed.
- **In the UI**, use `useCan()` (`apps/web/src/lib/auth.ts`) to hide menu items, tabs and buttons. The server enforces permissions anyway.
- Security-relevant actions write to `app.AuditLog` (`auth/audit.ts`): sign-ins, users, roles, AD config.
- **`ALLOW_TEST_LOGIN=true` is for this PC's browser tests only** (sign-in without a password, from localhost). It must never be set on a server.
- Never write a real password into code, tests, docs or `.env`. Credentials are typed into Configuration by the user and stored encrypted.

## Commands

- `npm install` — install all workspaces
- `npm run db:migrate` — apply pending migrations to the `supplychain` DB
- `npm run dev` — API on :4300 and web on :5300
- `npm run typecheck` / `npm test` / `npx playwright test` (smoke tests; needs `npm run dev` running)
- `start-supplychain.bat`: starts the app and logs to `logs\app.log`. `install-autostart.bat` / `remove-autostart.bat` add or remove the Windows Startup shortcut, which runs at logon as that user; the database uses their Windows login.
