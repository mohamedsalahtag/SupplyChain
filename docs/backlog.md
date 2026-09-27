# Backlog

Ideas and functions that are **not** in an approved screen spec yet. Each is added later, one at a time, through the screen loop in `CLAUDE.md`.

| # | Idea | Raised | Screen |
|---|------|--------|--------|
| 1 | ~~Login, users, roles and permissions~~ (done 2026-09-24) | 2026-09-23 | 05–07 |
| 2 | Replace the personal AD search account with a service account from IT | 2026-09-24 | 05 |
| 3 | Security: "Compare all roles" matrix view | 2026-09-24 | 07 |
| 4 | Give roles automatically from AD group membership | 2026-09-24 | 06/07 |
| 5 | ~~Warn before the 10-hour session ends~~ (not needed: sessions last 30 days since 2026-09-26) | 2026-09-24 | 05 |
| 6 | Screen to browse the audit log | 2026-09-24 | — |
| 7 | ~~Thread panel and Attachments panel (UI + upload/download endpoints)~~ (done in Stage 1) | 2026-09-24 | 14 |
| 8 | Management view of escalated work items (Stage 0 only tags rows "Escalated") | 2026-09-24 | 10 |
| 9 | Notification delivery: email / Teams from scm.NotificationOutbox (plan Stage 9) | 2026-09-24 | — |
| 10 | Plan v5 §0.12 says "2026-W53 is rejected", but 2026 has 53 ISO weeks (1 Jan 2026 is a Thursday). The code follows the ISO rule; the plan example should be corrected | 2026-09-24 | — |
| 11 | Plant-level purchasability (material × plant): no SAP data yet; phase 1 checks only that the material is in SAP. All companies use plant HO01 | 2026-09-24 | 11 |
| 12 | Discard an unwanted draft demand (records are never deleted; needs a Discarded state). Test drafts D-000001…D-000003 and the test demand D-000004 exist in the dev database | 2026-09-24 | 12 |
| 13 | Copy a demand; Excel import of demand lines; Excel export of the Demands list; saved filters | 2026-09-24 | 12, 13 |
| 14 | Save a container make-up (materials + shares) as a reusable template | 2026-09-24 | 12 |
| 15 | ~~E2E test user for the second department~~ (done 2026-09-24 as View as + demo accounts, spec 16) (e.g. `e2e.procurement`, Procurement role, company 1000) so the "decide a change request" path runs in the browser too; today the only other active user is a real person, so deciding is covered by the DB tests only | 2026-09-24 | 14 |
| 16 | Company-wide list of merges (today each demand lists its own on the Merges tab) | 2026-09-24 | 17 |
| 17 | **Before production:** READ_COMMITTED_SNAPSHOT on the database so reads never wait for writers. Found again 2026-09-25: while a SAP materials sync runs (minutes of MERGE on md.Material), submitting a demand waited 15–20 s behind it. Users would feel this if a sync runs in working hours — until then, schedule syncs outside working hours | 2026-09-24 | — |
| 18 | Discard or archive the automated-test demands (dozens of "Automated test — ignore" demands in the dev database) | 2026-09-24 | 12 |
| 19 | ~~Supplier view as a real Excel file (.xlsx) instead of CSV~~ (done 2026-09-25: ExcelJS, loaded on demand; the reports too) | 2026-09-24 | 18 |
| 20 | ~~Invite more suppliers to an existing RFQ~~ (done 2026-09-25); add quantity to an existing RFQ | 2026-09-24 | 18 |
| 21 | "Open quantity near ETD" exceptions are raised for the automated-test demands too (hundreds on My work in the dev database) — goes with discarding test demands (item 18) | 2026-09-24 | 18 |
| 22 | A Sales change request that cancels awarded quantity shrinks the award items but not the award's container count (the cancelled quantity is rarely whole containers) — decide how containers follow a partial cancellation | 2026-09-24 | 20 |
| 23 | Round trips: other multi-step commands (RFQ create/release, merge, change-request apply, un-award by containers' award-item bookkeeping) still move slices one query at a time — move them to the set-based sliceBatch fragments like the award (spec 20 performance fix) | 2026-09-24 | 20 |
| 24 | ~~Payment-term descriptions~~ (done 2026-09-27, migration 0032, from the company's code list); still open: `0004` and `ME00` have no description, and a code the supplier sync adds later starts blank (describe it in Configuration → Shipping terms) | 2026-09-25 | 22 |
| 25 | ~~Return after the PO is submitted, and voiding an unsubmitted PO draft on return~~ (done in Stage 7: return blocked once submitted, open drafts voided) | 2026-09-25 | 22 |
| 26 | **Required before production:** the company's PO API (Configuration → SAP purchase orders and the generic HTTP adapter exist since 2026-09-25; the field mapping `toSapBody` waits for the API contract), and the SAP field that stores the portal reference (POD-…). Run the Stage 7 fault suite against the SAP test system | 2026-09-25 | 23 |
| 27 | Plan Appendix C worked example as one end-to-end test (`e2e/worked-example.spec.ts`), asserting every KPI of the table | 2026-09-25 | 24 |
| 28 | Invariant gaps from the review: 8 (no award before a Procurement addition is applied), 13 (no content change after submit beyond splits), 16 (PO company = demand company), 22 (terms currency = award currency), 23 (supplier origin at award) | 2026-09-25 | — |
| 29 | Supplier freshness at invite/award: refresh one supplier from SAP on demand, and block an award when supplier data is older than the setting | 2026-09-25 | 18, 20 |
| 30 | KPIs still missing: Submit → Accept time; on-time in each company's time zone; "outstanding" for Procurement additions; a definitions/owner page per KPI in the app (the dictionary exists since 2026-09-27: `docs/reports/metric-dictionary.md`); container comparison across demands | 2026-09-25 | 24 |
| 31 | CI pipeline: ~~typecheck, unit, build and dependency audit~~ (done 2026-09-27, `.github/workflows/ci.yml`); still open: DB tests in CI and a lint rule that only `slices.ts` / `sliceBatch.ts` write `scm.QtySlice` | 2026-09-25 | — |
| 32 | Security follow-ups (review 2026-09): ~~HTTPS + built bundle on the server~~ (done 2026-09-25: TLS in the API or TRUST_PROXY, SERVE_WEB, production refuses to start without HTTPS); ~~session revocation (session version on `app.User`); login rate limit per username; authenticate uploads before reading the body; CSP; SAP purchase-order history scoped by company~~ (done 2026-09-27, professional review); still open: malware scan of attachments; shared login throttle store if the API ever runs as more than one process | 2026-09-25 | — |
| 33 | UX follow-ups (review 2026-09): breadcrumbs instead of back links; warn before leaving unsaved edits; reason descriptions instead of codes everywhere; keyboard access to the award squares and list rows; `formatDate` for date-only fields; CR statuses in `lib/statuses.ts` with hover text; My work ⋯ menu (spec 10) | 2026-09-25 | — |
| 34 | Code follow-ups (review 2026-09): `openInbox` race on the unique open index; aging job opens/closes items without a domain event; `isoWeekOf(new Date())` uses UTC (Monday 00:00–03:00 KSA is still last week); unit increments in partial approvals; shared helpers for duplicated code (lockRfq, reason checks, line labels) | 2026-09-25 | — |
| 36 | Database (review 2026-09-26): Query Store on; weekly index/statistics maintenance; nightly delete of CommandLog older than 30 days and archive of closed InboxItems older than a year; DB_POOL_MAX 20–30 on the server; later, full-text index for material search and a KPI table per PO-created slice for all-years performance reports | 2026-09-26 | — |
| 35 | Migration loader for opening balances and SAP reconciliation (plan §10.1) — today the app starts empty (see `docs/operations/cutover.md`) | 2026-09-25 | — |
| 37 | Demands list filters from the URL (`?status=`, `?week=`), so dashboard cards (spec 26) can open it pre-filtered — today a card opens the list, the demand or the My work tab | 2026-09-26 | 13, 26 |
| 38 | Dashboard cards offered in the mockup but not chosen (spec 26): PO pipeline, where the time goes (stage hours incl. Submit → Accept), handoff returns by reason, containers by origin, awarded and ordered value per currency, price vs last SAP purchase | 2026-09-26 | 26 |
| 39 | The other report candidates of `docs/review/2026-09-26-report-candidates.md` (P2–P6, S2–S4, M2–M6); P1, S1 and M1 are built (spec 28) | 2026-09-26 | 28 |
| 40 | From the professional review (2026-09-27, `SupplyChain-Professional-Review.md`), not built yet: rename "Arrivals" (it shows ETD plans, not observed arrivals) once a real ETA/receipt source exists; dashboard exception summary first and role-ordered cards; scope sentence per report card (companies, cohort date, as-of time); report filters in the URL with return context; SQL paging for the Execution / CR register / Arrivals reports; background export for very large extracts; a small-screen report layout checked at 390/768/1024 px | 2026-09-27 | 24, 26, 28 |
| 41 | Infrastructure (review F19, for the DBA): SQL Server 2016 is at SP1 (13.0.4001) — patch to the latest SP3 CU/GDR; RCSI (item 17) and Query Store (item 36); proven full + log backup and restore drill with agreed RPO/RTO | 2026-09-27 | — |
| 42 | SAP sync workers could call `heartbeat(db, runId)` per page (today `launchSync` beats every 60 s for up to 2 h); `assertMayGrant` in users.add/update still runs before the transaction; "Log out" now signs out every device — decide whether the button label should say so | 2026-09-27 | 05, 06 |
| 43 | Production server (2026-09-27): company-CA certificate on SQL Server KSAJEDSVSQL003 so `DB_TRUST_SERVER_CERT=false`; DBA backup plan for `supplychain_prod` (full + log) and `C:\SupplyChainDatattachments`; the production `SETTINGS_ENCRYPTION_KEY` into the IT vault; renew the HTTPS certificate before 2028-09-26; optionally a friendly DNS name (supplychain.sharbatlyfruit.com) with its certificate | 2026-09-27 | — |
