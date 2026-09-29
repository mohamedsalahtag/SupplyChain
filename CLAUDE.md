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
- **The server is SQL Server 2016 (compatibility level 130).** No `STRING_AGG`, `CONCAT_WS`, `TRIM`, `TRANSLATE`, `GREATEST`/`LEAST`, `APPROX_COUNT_DISTINCT`. Aggregate strings in TypeScript instead. The ODBC driver reports these as misleading errors (e.g. "Invalid usage of the option next in the FETCH statement").
- **T-SQL reserved words** cannot be column names without brackets (e.g. `LineNo` failed; use `LineNumber`). The migration runs in a transaction, so a failed file changes nothing.
- **msnodesqlv8 returns IDENTITY columns as strings.** Wrap them in `Number()` where they are read.
- **SAP (OData):** `apps/api/src/sap/odata.ts` serves both v2 (materials, business partners: `d.results`) and v4 (purchase orders: `value`). SAP returns at most **5,000 rows per page**, so always page. Every value put into a `$filter` is validated first (codes `^Z[A-Z0-9]{1,9}$`, dates `YYYY-MM-DD`).
- **Every SAP sync** uses `modules/sync/`: `launchSync` (background start, one run per source), `finishRun` (result row), `sync.status` (UI), `codeList` ("load the list from SAP, then choose"). Writes are keyed upserts (`MERGE` from `OPENJSON`), so pressing Sync again never duplicates. In the UI, use `SyncCard` and `CodeChoiceCard`. **Schedule (spec 30):** Configuration → SAP → Sync schedule sets days and hours (Saudi time, UTC+3) per source; `runScheduledSyncs` (every minute in `server.ts`) starts the same job as the button (`modules/sync/jobs.ts`, shared — change a sync there, not in its router), as "Scheduler", once per hour slot.
- Store timestamps with `SYSUTCDATETIME()` on the database side, never `new Date()` from Node. Send them to the UI as ISO strings.

## Workflow (Demand-to-PO, plan v5)

Built stage by stage from `Demand_to_PO_Execution_Plan_v5.md`; one stage at a time, each with its specs (10+) and user acceptance. Shared code is in `apps/api/src/modules/workflow/`:
- **Errors:** services throw `DomainError(code, message, status)`; the tRPC layer maps 403/404/409/422 and puts `domainCode` + `details` in the error data.
- **Access:** `loadActor` + `assertCan(actor, permissionKey, companyCode)`: permission **and** one of the user's companies (`scm.UserCompany`). Child ids go through `assertBelongs` (404, never 403).
- **Commands:** every business mutation runs through `runCommand(db, userId, commandId, name, fn, input)` (duplicate-safe, one transaction, deadlock retry). The log row is inserted first; a reused id with another name or input is refused (`COMMAND_KEY_REUSED`). **Always pass `input`** (the business parameters, not db/actor/commandId). Objects the user decided on carry `RowVer`; check it with `updateWithRowVer`.
- **RowVer to hex:** always `rowVerHex()` — `CONVERT(varchar(16), RowVer, 2)` silently returns raw bytes for `rowversion`; it must be cast to `binary(8)` first.
- **Quantities** are BIGINT milli-units through `qty.ts` only; **weeks** are `YYYY-Www` through `isoWeek.ts`.
- **My work:** open/close items with `openInbox` / `closeInbox` in the same transaction as the action; register new types in `ITEM_TYPES`.
- **Origins:** a supplier's origin is its SAP Country code; material origin names map to codes through `scm.RefOrigin` (only canonical ISO codes: deprecated ones like FX = France are skipped).
- **Quantity ledger:** only `transitionSlice` changes a slice's state and only `splitSlice` changes its quantity (`modules/workflow/slices.ts`). Status after acceptance comes from `deriveStatus` (TS) and `scm.vDemandStatus` (SQL); a DB test keeps them equal.
- **Invariants:** `tests/invariants/*.sql` must return no rows; DB tests call `runInvariants()` after each scenario. Add each stage's invariants (plan §6.1).
- **Set-based slice moves:** multi-row steps use `sliceBatch.ts` (`takeTransitionSql`, `moveSlicesSql`, `runSliceBatch`) plus `eventSql` / `threadEntrySql`: one round trip instead of one per slice (VPN latency). They repeat the state-machine rules in SQL; a DB test keeps them equal.
- **SAP outbox (spec 23):**
  - External calls never run inside a transaction or under a lock (`resolveUnknown` asks SAP first).
  - Every outcome write is conditional on the draft still being open (`markCreated` / `markRejected` return false otherwise, and the outbox raises a "late SAP reply" exception).
  - `runOutbox` runs one pass at a time per process and claims **one row at a time** with its own claim token; every outcome write checks `ClaimedBy = token AND LeaseUntil > now`, and a row is only sent when its lease covers the whole call. CSRF + POST share one time budget (`timeoutSeconds` ≤ 120).
  - A lookup is NOT_FOUND **only** for a JSON empty OData list; anything else (HTML, `{}`, 404, error body, records without our reference, several different POs) is UNKNOWN — never a reason to resend (`interpretLookup` in `sapHttpAdapter.ts`).
  - A production server refuses `http://` and self-signed certificates for the SAP PO API.
  - The adapter is `poAdapter(db, encKey)`, chosen on every call from **Configuration → SAP purchase orders** (`settings/sapPoApi.ts`): the simulator or the company's PO API through the generic HTTP adapter (`modules/po/sapHttpAdapter.ts`; only `toSapBody` should change when the API contract arrives). A production server refuses to submit to the simulator unless `ALLOW_SAP_STUB=true`. Fault injection needs `configuration.sap.edit`.
- **Exports are Excel** (`lib/excel.ts`, ExcelJS loaded on demand): numbers stay numbers, header frozen and filtered. No CSV.
- **Separation of duties:** the creator of a demand can't accept it; whoever handed off can't accept the handoff; nobody decides their own CR (admins excepted). Non-admin user/role editors can only give what they hold (`assertMayGrant`, `assertMayEditRole`).
- **Demand progress (specs 13, 21):** the stages, who owns each (Procurement / PO team / Sales), the Demands list "Waiting on" column and filter, and the demand page's "What's left" all come from `modules/demand/progress.ts` (`progressFor`, `waitingSql` — the filter and the column share it — `waitingFor`, `whatsLeft`); RFQs use it too (`modules/rfq/rfqProgress.ts`, `whatsLeft(…, { rfqId })`); the Awards list and the award page use the same module (`awardProgressFor`, `awardWaitingSql`, `awardWaitingFor`, `whatsLeft(…, { awardBatchId })`). A new workflow step that makes someone act must be added there.
- **Reports (spec 24)** read the ledger directly (`modules/reports`): never add across units, a zero denominator is N/A, and the From/To filter applies to every section. The **Dashboard tab (spec 26, `modules/reports/dashboard.ts`)** opens first: "now" cards are live and ignore the dates, "period" cards default to the last 12 weeks; charts are plain SVG in `components/Charts.tsx` (no chart library). **Arrivals, Suppliers and Trend (spec 28, `modules/reports/insights.ts`)**: arrivals from the current ETD week onward, the supplier scorecard over the last 12 months, the trend in one pass over the range bucketed by month (`headlineOf` is shared with Performance — never run a heavy report once per month; `src/scripts/timeReports.ts` times them and checks trend = performance). The web client sends `reports.*` queries unbatched (`splitLink`), because a batched reply waits for its slowest query. Sessions last 30 days. SQL Server refuses an aggregate over a subquery — compute the flag in a CROSS APPLY first. **Quantities are added in milli-units only** (`modules/reports/pure.ts`; the 2026-09-27 review found headline totals 1000× too small from a second conversion) and the unit tests there assert absolute totals. Tab counts come from `reports.counts` (COUNT queries only); a tab's data loads when it opens. The search `q` narrows every Performance section and is disabled on Dashboard and Trend. Trend clamps its first/last month to the exact dates and keeps the **latest** 24 months. Exports: only columns declared numeric become numbers (ids stay text) and report exports carry an "About this export" sheet. KPI meanings: `docs/reports/metric-dictionary.md`.
- **Git:** `https://github.com/mohamedsalahtag/SupplyChain.git`, branch `main`. Commit only when the user asks.
- **Migrations:** 0021 = PO and SAP outbox, 0022 = `reports.open` grants, 0023 = RFQ to a supplier outside the shortlist, 0024 = saved page sizes of 25 → 50, 0025–0028 = database review (indexes, status view; 0027's indexed views removed again by 0028).
- **Next migration number: 0033.** (0032 = payment-term descriptions; 0029 = `app.User.DeletedAt`, user delete; 0030 = `app.User.SessionVersion`; 0031 = `scm.CommandLog.InputHash` + `integ.SyncRun.HeartbeatAt`.)
- **Database performance rules (review 2026-09-26, `docs/review/2026-09-database-review.md`):**
  - Lists page **in SQL** and fetch details for the page only. Never load a whole table to filter or page in memory, and never send an unbounded list of IDs as parameters (SQL Server stops at ~2,100 parameters and 10,000 variables).
  - A **filtered index** (`WHERE IsOpen = 1`, `IsCurrent = 1`) is only used when the query writes that value as a **literal** (`sql\`IsOpen = 1\``), never as a parameter.
  - **Never `UPDLOCK, HOLDLOCK` on a key that may not exist yet** (get-or-create): it takes a range lock, and objects created together (neighbouring ids) queue for their whole transaction. Insert and treat a duplicate key as "already created" (`threadSql` in `threads.ts`). No aggregate indexed views on write-hot tables for the same reason (tried and reverted, 0027 → 0028).
  - `scripts/perf/contention.ts N` submits N demands at once on `supplychain_perf` and prints what SQL Server waits on.
  - A foreign key the app looks rows up by gets an index. Measure a new heavy screen with `apps/api/scripts/perf/` (`build.ts` → `supplychain_perf` with 20,000 demands, `bench.ts` → database time and pages per screen).

## UI conventions

- **Compact and dense.** Screens will carry many details. The theme in `apps/web/src/main.tsx` uses antd's `compactAlgorithm` for spacing, `componentSize="small"` and tight table rows. Don't override it per screen.
- **Font size, site name and icon are app-wide settings** (Configuration → Appearance / General; `ui.appearance` and `ui.branding` in `app.Setting`; default font 13px). The font number is the real on-screen size: `keepChosenFontSize` stops the compact algorithm from shrinking text. Never hard-code font sizes, the site name or the icon in screens.
- **Tabs show how many records they hold**: use `TabLabel` with `countOf(query.data)` (`components/TabLabel.tsx`) on every tab title. Run the tab's query in the parent with the **same input** (shared cache, no extra call).
- **Configuration** is a vertical menu grouped by subject (General · SAP · Workflow · Sign-in), with the section beside it. A new section gets a `group` in `ConfigurationPage.tsx`.
- **Every table is an `AppTable`** (`apps/web/src/components/AppTable.tsx`) with `useTablePrefs('<table-key>')`. That gives 25 / 50 / 100 rows per page (default **50**) and a Columns chooser. Both are saved **per user in `app.UserPreference`**, so they survive restarts and change only when the user changes them. Every column needs a stable `key`, a text `title` and a numeric `width`.
- **No table ever scrolls sideways.** `AppTable` turns column widths into shares of the page width (`tableLayout="fixed"`), and long text ends in "…" with the full text on hover. Don't pass `scroll` or `fixed` columns. Columns that should start hidden go in `useTablePrefs('<table>', defaultHidden)`. "Default columns" in the chooser brings them back. API list inputs accept only `TABLE_PAGE_SIZES` from `@supplychain/shared`.
- **Every list filters through `useListFilters`** (`components/ListFilters.tsx`, spec 31): search box in the toolbar, the rest in a collapsed Filters section (`AppTable beforeTable`) with Apply / Clear all, chips, values in the page address. Dropdowns are multi-select with search (dependent lists via `parentKey`, e.g. Sub-major under Major); weeks and dates are ranges. Choices come from the list's `filterOptions` procedure. API filter inputs are arrays, matched with `in`. `MultiFilter` remains for small in-page choices only.
- Page titles are `Typography.Title level={5}`. Tables are `size="small"` and `bordered`. Record details open in a read-only `Drawer`.

## Security

- **Sign-in is Active Directory** (`apps/api/src/auth/`). The user's own password is checked by binding to AD over LDAPS. Only users registered on the Users page can sign in. Sessions are an httpOnly, SameSite=Strict cookie holding the user id and `app.User.SessionVersion`; the user and their permissions are reloaded from the DB on every request, and a cookie with an older version is refused. The version is bumped on logout (signs out every device), role/active/company changes and archiving. Archived users (`DeletedAt`) can't sign in and can't be edited. Login is throttled per IP (10/min) and per username (5/min).
- **Every screen and button is in the permission catalogue** (`packages/shared/src/permissions.ts`). The Security page shows exactly that list. A new screen or button **must** add its entry there.
- **Every procedure declares a catalogue key** with `procedure.meta({ permission: P.xxx })`, or `SIGNED_IN` for things any signed-in user needs (own preferences, theme). `publicProcedure` is only for sign-in and the health check. `apps/api/src/trpc/trpc.spec.ts` fails if a procedure uses an unknown key or is public without being on its short list.
- The Administrator role (`IsAdmin`) holds every permission, including future ones. Nobody can disable themselves or remove their own admin role, and the last active admin can't be removed.
- **In the UI**, use `useCan()` (`apps/web/src/lib/auth.ts`) to hide menu items, tabs and buttons. The server enforces permissions anyway.
- Security-relevant actions write to `app.AuditLog` (`auth/audit.ts`): sign-ins, users, roles, AD config. User and role changes use `auditTx` inside their own transaction (no change without its audit row); sign-in events stay best-effort.
- Unexpected errors reach the browser only as "Internal error" + an error id (`E-…`) that is in the log; 4xx/DomainError messages are unchanged. Imported SAP purchase orders are company-scoped like the workflow. Uploads are authenticated before the body is read (own Fastify plugin) and checked by their first bytes (`fileSignature`).
- **Maintenance (spec 29):** Configuration → Start over (`modules/ops/purge.ts`) deletes every workflow record in one transaction and restarts the number sequences; refused when `NODE_ENV=production`, **allowed only with `ALLOW_PURGE=true`**, and refused while a SAP submission is open (PENDING/IN_FLIGHT/UNKNOWN/MANUAL) or a sync is running (app lock `scm.maintenance`). POD numbers are **not** restarted (SAP stores them). **A new workflow table must be added to its `TABLES` list** (children first), or the purge fails on its foreign key. **Never run it from an e2e test** — e2e uses the real dev database. Users → Delete (`modules/users/userDelete.ts`) deletes outright, or archives (`app.User.DeletedAt`, username freed, display name kept) when the user is on records. The built-in logo is `apps/web/public/logo.ico`.
- **`ALLOW_TEST_LOGIN=true` is for this PC's browser tests only** (sign-in without a password, from localhost). It must never be set on a server. With `NODE_ENV=production` the API **refuses to start** if `ALLOW_TEST_LOGIN` or `ALLOW_VIEW_AS` is on, without HTTPS, with `TRUST_PROXY=true` on a non-loopback `HOST` (give the proxy IPs instead), without `DB_ENCRYPT=true`, or with a non-`ldaps://` `AD_URL` (`productionProblems` in `config.ts`). Saved AD settings with `ldap://` or self-signed are refused in production. HTML replies carry a CSP.
- Every reply carries `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` and `COOP`. The public health check never returns error text. Saved AD/SAP passwords are never reused for a changed address or account.
- **Operations status** (Administration, `operations.open`, spec 25) is the daily check. The runbooks, restore drill, cutover, UAT script and security checklist are in `docs/operations/`. The full review of 2026-09-25 is in `docs/review/`.
- **Runtime settings that matter (found 2026-09-24):** the API starts through `apps/api/scripts/dev.mjs`, which sets `UV_THREADPOOL_SIZE` (32) before Node starts — the ODBC driver runs each query on a worker thread, and with Node's default 4 threads, reads blocked behind a transaction's locks stalled that transaction until the 15 s query timeout. Keep `DB_POOL_MAX` below it. Fastify runs with `maxParamLength: 5000` (tRPC batch paths), and the Vite proxy targets `127.0.0.1` (Windows `localhost` tries IPv6 first: +200 ms per call).
- **`ALLOW_VIEW_AS`** (spec 16) lets administrators switch into the demo accounts (`demo.sales`, `demo.procurement`, `demo.both`, `app.User.IsDemo=1`) to test other departments; `false` on the live server. Two-person flows in e2e use `viewAs()` from `e2e/helpers.ts`.
- Never write a real password into code, tests, docs or `.env`. Credentials are typed into Configuration by the user and stored encrypted.

## Commands

- `npm install` — install all workspaces
- `npm run db:migrate` — apply pending migrations to the `supplychain` DB
- `npm run dev` — API on :4300 and web on :5300
- **The production server is live** (KSAJEDSVSCM001, https://KSAJEDSVSCM001.sharbatlyfruit.com, DB `supplychain_prod`): see `docs/operations/production-server.md`. It has no internet; publish with `pwsh deploy/publish-production.ps1` (tests, backup, migrations, copy, restart, health). Never point dev or e2e at `supplychain_prod`.
- `npm run build` then `npm start` — production: one process serves the built web app and the API (`SERVE_WEB=true`, HTTPS via `TLS_PFX_FILE` or `TRUST_PROXY`); see `docs/operations/production-setup.md`. With `NODE_ENV=production` it refuses to start without HTTPS or with a test switch on
- CI (`.github/workflows/ci.yml`, Windows runner): typecheck, unit tests, build, `npm audit --audit-level=high`.
- `npm run typecheck` / `npm test` / `npx playwright test` (smoke tests; needs `npm run dev` running)
- `npm run help:pdf` — regenerates the user guide (`apps/web/public/help/user-guide.pdf`, spec 27) from `docs/help/user-guide.html` with headless Edge. **A spec that changes a step or a rule also changes the guide.**
- **Browser tests run against the real dev database as the real administrator.** A test that changes a setting or a preference (site name, icon, font, rows per page, columns) must read the user's saved value first and put **that** back in a `finally` — never the built-in default (found 2026-09-25: the user's icon and page sizes were being reset by test runs).
- `npm run test:db` — service tests and `tests/invariants/*.sql` against a throw-away `supplychain_test` database (recreated and migrated each run; never the real one). It runs through `apps/api/scripts/test-db.mjs` (sets `UV_THREADPOOL_SIZE`, like dev.mjs); run only one at a time (they share the test database). Over a slow link to SQL Server (VPN, ~100 ms ping) the full run takes ~20 min; e2e then needs `E2E_EXPECT_TIMEOUT=20000`
- `start-supplychain.bat`: starts the app and logs to `logs\app.log`. `install-autostart.bat` / `remove-autostart.bat` add or remove the Windows Startup shortcut, which runs at logon as that user; the database uses their Windows login.
