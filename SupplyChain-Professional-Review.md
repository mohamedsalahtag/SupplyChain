# Supply Chain — Professional Application Evaluation

**Review date:** 26 September 2026  
**Application:** `C:\SupplyChain`  
**Scope:** code, defects, functional gaps, database performance, security, UX, reports and dashboards  
**Disposition:** review only; no fixes implemented  
**Baseline:** working checkout at commit `2ad642d231d374bc7e2a7d7d46bcf8ad342a6cb0`, including existing modified and untracked files.

## 1. Executive assessment

The application has a credible architecture for demand-to-purchase-order processing. Central permission checks, company-scoped workflow services, quantity slices, optimistic concurrency, transactional commands, immutable-history mechanisms and a SAP outbox provide a much stronger foundation than a collection of independent CRUD screens. Type checking passed, all 116 unit tests passed, and all 23 read-only invariant scripts returned zero violations against the current development data.

**The application should remain in development/UAT until the high-priority correctness and integration findings are addressed.** The most important confirmed defect is a thousandfold understatement of headline quantities in Performance, Dashboard and Trend; fractional totals can instead cause the report to fail. A second confirmed defect treats an unexpected successful SAP lookup response as proof of absence, creating a resend risk. Security and operational concerns include non-revocable 30-day sessions, company-unrestricted SAP PO browsing, unsafe transport options, dependency advisories, and an old database engine build.

The database was responsive for the sampled read-only report calls on the current small dataset. This is not evidence of readiness for concurrent users or years of history. Reports still fetch complete datasets, several heavy queries run merely to display tab counts, and both read-committed snapshot and Query Store are off. Existing performance-review documents describe larger-scale work, but their historical measurements were not reproduced in this review.

The UI is coherent and recognizably designed for frequent desktop use. Its dense layout, reusable table controls, explicit status wording and chart/table alternatives are strengths. Improvements should focus on trustworthy numbers, clearer period/filter semantics, concise operational prioritization, accessible record actions, and preserving context across drill-downs. Adding more charts before correcting metric definitions would increase the risk of misleading users.

### Decision priorities

| Priority | Decision or deliverable | Why it matters |
|---|---|---|
| Before relying on KPIs | Correct quantity conversion and add independently calculated expectations | Current headline totals are materially wrong |
| Before real SAP submissions | Strict lookup response validation, concurrency-safe reconciliation, real API contract tests | Avoid duplicate POs and inconsistent settled states |
| Before broader access | Decide/enforce company scope for imported POs; close role-reactivation loophole | Commercial information and privileges need consistent boundaries |
| Before production | Harden sessions, transport, dependencies, database platform and deployment | Current development configuration is unsuitable for production |
| Before volume rollout | Bound report reads; measure simultaneous dashboards and writes on an isolated representative database | Single-user response times do not predict contention |

## 2. Method, evidence and limitations

Reviewed `CLAUDE.md`, package manifests, route/service structure, authentication, authorization, settings encryption, attachments, demand commands, reports, SAP adapter/outbox, maintenance/user deletion, migrations, tests, operational documents and selected UI components. References below use the reviewed working-tree line numbers, which can move after edits.

Performed:

- `npm run typecheck`: passed for the participating workspaces.
- `npm test`: **16 test files, 116 tests passed**. The API unit-test configuration includes `src/**/*.spec.ts`; it excludes DB integration tests.
- `npm audit --omit=dev --json`: **3 affected package entries: 1 high, 2 moderate, 0 critical**. These are package-level audit entries, not three proven exploitable application vulnerabilities.
- Executed the existing read-only schema inventory and an external review script for database configuration, constraint health, report timings and invariant queries.
- Ran isolated in-memory fixtures against the real `headlineOf` and `trendMonths` functions.
- Ran the real HTTP SAP adapter against an ephemeral loopback mock returning `{}`. No request was made to real SAP.
- Inspected the live authenticated Dashboard and Arrivals screens through Chrome screenshots/accessibility output, plus the demand-list navigation/structure. Used the existing session; no login or account changes were needed.
- Inspected current git status at the beginning and end; the same pre-existing modified/untracked paths remained. No application source, dependencies, configuration, schema or existing business data were intentionally changed.

No application test data was created. Review fixtures existed only in process memory. Review scripts and deliverables are in this output directory. The report functions use temporary SQL tables internally; no persistent schema or business-data writes were made by the review scripts. The already-running application and other users could continue their own normal activity during observation.

Not performed: full DB integration suite (its setup recreates a shared test database), mutating browser tests (the repository says they use the actual development database), live SAP submission, AD password testing, load/DoS testing, destructive maintenance testing, exploit attempts against real accounts, backup restore, production deployment validation, complete mobile/keyboard/screen-reader certification, or historical secret scanning. A production bundle build was not run. This is a comprehensive risk-oriented review, not a claim that every execution path or file was exhaustively verified.

**Evidence files:** `database-inventory.txt`, `database-probe-results.txt`, `pure-probe-results.txt`, `sap-probe-results.txt`, `dependency-audit.json`, and the three corresponding external `.mts` probe scripts. Unit-test/typecheck outcomes above were observed in command output; they are not represented as freshly rerun integration tests.

### Classification

- **Confirmed defect:** directly reproduced, or an unambiguous mismatch in the inspected control/data flow. Evidence level is stated per finding.
- **Risk:** a reachable concerning design/configuration with an impact dependent on deployment, data or concurrency; not claimed as a demonstrated incident.
- **Suggestion/gap:** an improvement or product decision, not automatically a violation of an approved screen specification.
- **High:** material data/decision error, privilege or confidentiality exposure, or external transaction integrity risk. **Medium:** significant reliability, scalability or usability issue. **Low:** bounded polish/maintainability issue. No critical exploit was established.

## 3. Findings register

### F01 — High · Confirmed, reproduced · Headline quantities converted twice

**Evidence:** [reports.ts:189](C:/SupplyChain/apps/api/src/modules/reports/reports.ts:189), especially lines 193 and 214; [qty.ts:17](C:/SupplyChain/apps/api/src/modules/workflow/qty.ts:17). `executionSummary` already returns decimal unit strings. `headlineOf` converts those to numbers, adds them, then passes the unit totals to `q3`, which expects integer milli-units and divides by 1,000 again.

**Validation:** the fixture with committed `1000.000` and executed `500.000` returned `1.000` and `0.500`. A committed input of `1000.125` threw “quantity must be an exact quantity.” The live dashboard independently showed headline committed **1,246.231**, while Demand stability showed **1,246,231** for its period; the headline executed quantity was **9.24**. Ratios can still look plausible because both operands use the same erroneous scale before formatting.

**Impact:** materially false totals in Dashboard, Performance, Trend and their dependent exports; legitimate fractional aggregates may fail an entire report.

**Remediation:** keep aggregation in validated integer milli-units, converting only at the output boundary. Use distinct quantity types to prevent unit/milli-unit mixing. Add fixtures for 1,000, 0.125, mixed units, multiple rows, cancellation and procurement additions. Assert absolute totals against independent expected values, not only equality between reports sharing this helper.

### F02 — High · Confirmed, reproduced · Unexpected SAP lookup payload becomes NOT_FOUND

**Evidence:** [sapHttpAdapter.ts:95](C:/SupplyChain/apps/api/src/modules/po/sapHttpAdapter.ts:95); [outbox.ts:95](C:/SupplyChain/apps/api/src/modules/po/outbox.ts:95). The adapter returns `NOT_FOUND` when an HTTP-successful response does not contain the configured PO field. The reconciler interprets that as permission to schedule another create attempt.

**Validation:** a loopback mock returned HTTP 200 and `{}`; the actual adapter returned `{"kind":"NOT_FOUND"}`. The fixture never contacted real SAP.

**Impact:** an authentication interstitial, changed response shape, wrong field mapping or malformed JSON response can be mistaken for authoritative absence. Duplicate-creation impact depends on the real SAP endpoint's idempotency guarantee. Sending an idempotency header alone does not establish that guarantee.

**Remediation:** validate the response contract strictly. Only an explicit recognized empty result or contract-defined not-found response should mean absence; malformed/unrecognized replies remain UNKNOWN. Verify reference equality and uniqueness when a PO is found. Test malformed 2xx, HTML responses, wrong property paths, ambiguous 404s and multiple matches against the actual integration contract.

### F03 — High · Risk, code-confirmed race path · Late reconciliation can reopen a settled draft

**Evidence:** [outbox.ts:35](C:/SupplyChain/apps/api/src/modules/po/outbox.ts:35), [outbox.ts:94](C:/SupplyChain/apps/api/src/modules/po/outbox.ts:94). `toManual` unconditionally sets submission status MANUAL and draft status UNKNOWN. It may run after an awaited lookup while another action resolves the same draft. The FOUND reconciliation branch also ignores `markCreated`'s false return, unlike the create-response branch, which raises a late-reply exception.

**Impact:** a delayed reconciliation can overwrite a manually settled CREATED/REJECTED state, leaving its ledger and draft inconsistent; a late found PO can fail to create an actionable exception. The race was not executed against business data.

**Remediation:** condition all outcomes on expected state plus claim/lease ownership, check affected rows, and handle every late outcome explicitly. Add an isolated test with a deferred lookup, manual settlement, then release of the deferred reply. Assert draft, submission, slices and inbox remain consistent.

### F04 — High · Risk, calculable from code · Batch claims can expire before processing begins

**Evidence:** [outbox.ts:13](C:/SupplyChain/apps/api/src/modules/po/outbox.ts:13), lines 65–71 and 88–92; [sapHttpAdapter.ts:46](C:/SupplyChain/apps/api/src/modules/po/sapHttpAdapter.ts:46); [sapPoApi.ts:27](C:/SupplyChain/apps/api/src/settings/sapPoApi.ts:27). Five rows receive the same five-minute lease, then are processed sequentially. Each create may perform both a CSRF request and a POST, each with its own timeout up to 240 seconds.

**Impact:** later items can have expired leases before their first external call; even one CSRF+POST sequence can exceed the lease. The in-process single-flight guard does not protect against another API process. This is especially relevant when scaling beyond one worker.

**Remediation:** claim immediately before each operation, renew/fence ownership, and enforce an end-to-end operation budget that fits the lease. Test two workers with delayed responses and process termination on an isolated database.

### F05 — High · Confirmed scope gap · Imported purchase orders bypass company restrictions

**Evidence:** [purchaseOrders/router.ts:35](C:/SupplyChain/apps/api/src/modules/purchaseOrders/router.ts:35), lines 69–86. List, line detail and type options enforce `purchaseOrders.open` but do not load actor companies or join a requested order to an authorized company. Line detail exposes commercial quantities/prices by order number.

**Impact:** a user with this catalogue permission can read the imported PO dataset across companies. Workflow and reports otherwise use company scope. The older PO screen specification does not explicitly promise company isolation, so this is a confirmed security boundary gap requiring a policy decision, rather than a claim that the implementation violates that specific screen spec. The backlog already identifies it as a security follow-up.

**Remediation:** default to company filtering on every PO query and child lookup; if all-company visibility is intentional, introduce a distinct explicit permission. Test a one-company reader against another company's order and detail endpoint. No cross-company account was impersonated during this review.

### F06 — High · Risk, code-confirmed path · Reactivating a powerful role bypasses grant checks

**Evidence:** [security/router.ts:16](C:/SupplyChain/apps/api/src/modules/security/router.ts:16), [security/router.ts:101](C:/SupplyChain/apps/api/src/modules/security/router.ts:101). A non-admin role editor cannot grant keys they lack or edit a role they hold. However, `updateRole` invokes `assertMayEditRole` with an empty key array before allowing `IsActive` to become true.

**Scenario:** an inactive, non-built-in role contains permissions the editor does not hold and remains assigned to another account. The editor can reactivate it without checking those retained permissions, restoring greater access to that account. Built-in roles are protected; this finding concerns custom roles. No role was changed to test it.

**Remediation:** treat activation as granting the role's current effective permissions, checked inside the same transaction. Serialize relevant permission/assignment edits or use row versions. Add a negative test for reactivating a higher-privilege role through a lower-privilege editor.

### F07 — High · Confirmed security limitation · Logout does not revoke a copied session

**Evidence:** [session.ts:9](C:/SupplyChain/apps/api/src/auth/session.ts:9), [auth/router.ts:143](C:/SupplyChain/apps/api/src/auth/router.ts:143), [authUser.ts:24](C:/SupplyChain/apps/api/src/auth/authUser.ts:24). JWTs last 30 days. Logout only clears the browser cookie; there is no session registry or per-user token version. App-user and role status are reloaded, which correctly blocks a disabled app account, but AD is not consulted on subsequent requests.

**Impact:** a copied token remains valid after logout until expiry or application-account disablement; an AD disable/password reset alone does not invalidate it. Re-enabling an app account can make an unexpired old token useful again. The chosen 30-day duration is an explicit product preference; the defect is lack of revocation, not that preference itself.

**Remediation:** support server-side revocation/session versioning, revoke on sensitive account events, define AD offboarding synchronization, and provide “sign out all sessions.” Keep the desired duration if appropriate, with effective revocation. No real token was copied or replayed.

### F08 — High before production · Observed configuration and guardrail gap · Transport and trust are not comprehensively enforced

**Evidence:** [config.ts:15](C:/SupplyChain/apps/api/src/config.ts:15), [config.ts:56](C:/SupplyChain/apps/api/src/config.ts:56), [server.ts:34](C:/SupplyChain/apps/api/src/server.ts:34), [adConnection.ts:18](C:/SupplyChain/apps/api/src/settings/adConnection.ts:18), [ldap.ts:58](C:/SupplyChain/apps/api/src/auth/ldap.ts:58), [sapPoApi.ts:49](C:/SupplyChain/apps/api/src/settings/sapPoApi.ts:49).

Observed local configuration requests DB encryption off and trusts the server certificate; both test-login and View-as switches are on. These are development observations, not proof of how production is deployed. The API listens on all IPv4 interfaces at port 4300; Vite was listening on loopback at port 5300. The production guard correctly refuses test switches and requires TLS or proxy trust, but it accepts boolean `TRUST_PROXY=true` without proving a restricted proxy topology. LDAP and SAP settings can permit cleartext protocols or disabled certificate validation.

**Impact:** a misdeployed server can trust forwarded headers from arbitrary clients; secrets can cross unverified or unencrypted upstream connections. The current DB client settings do not prove actual negotiated wire encryption because the server could force it. Loopback test-login checks can also be undermined if a local reverse proxy exposes the development endpoint; current Vite loopback binding limits that observed route.

**Remediation:** enforce secure upstream schemes/certificate validation in production, constrain trusted proxy addresses/hops, bind the backend to the intended interface, verify firewall/proxy configuration, and establish an explicit secure deployment profile. Keep test endpoints unavailable on server deployments independent of informal conventions. Do not deploy the current development environment file unchanged.

### F09 — Medium · Confirmed dependency advisories; application exploitability unproven

**Evidence:** `dependency-audit.json`; [API manifest](C:/SupplyChain/apps/api/package.json), [server.ts:77](C:/SupplyChain/apps/api/src/server.ts:77). The production dependency audit reports high severity for `@fastify/static` and moderate entries for `exceljs` and transitive `uuid`.

The Fastify maintainer advisory describes route-guard bypass for protected static files. Here static serving uses a built web directory, `wildcard:false`, and attachments are separately authorized. This reduces the obvious applicability; no protected-file bypass was established. The UUID advisory is conditional on affected methods and supplied buffers; the affected path was not demonstrated through Excel export. See the [Fastify advisory](https://github.com/fastify/fastify-static/security/advisories/GHSA-83w8-p2f5-377r) and [UUID advisory](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq).

**Remediation:** assess all audit entries and upgrade through a compatible tested dependency plan. The audit's suggested Fastify fix is a major change; do not blindly apply `audit fix --force` or downgrade ExcelJS merely to make the audit green. Test static routing, traversal rejection, API exclusions and exports after the selected update.

### F10 — Medium · Confirmed design risk · Upload authorization occurs after buffering

**Evidence:** [filesRoute.ts:19](C:/SupplyChain/apps/api/src/modules/workflow/filesRoute.ts:19), lines 34–36; [attachments.ts:18](C:/SupplyChain/apps/api/src/modules/workflow/attachments.ts:18), lines 63–68. The octet-stream parser buffers up to 100 MB before the route handler resolves the session. File classification is extension-based; no content inspection or malware quarantine was found in this path.

**Impact:** unauthenticated requests can consume substantial body-buffer resources before rejection; authorized uploads can distribute malicious content under an allowed extension. Download attachment disposition and checksum verification are positive controls, but do not scan content. No large-body or malware test was performed.

**Remediation:** authenticate in a pre-body lifecycle hook, enforce proxy/request/user quotas, stream uploads to bounded storage, validate content signatures and scan/quarantine before release. Keep downloads as attachments and retain checksum checks.

### F11 — Medium · Confirmed control limitation · Login throttling is per IP and process only

**Evidence:** [auth/router.ts:12](C:/SupplyChain/apps/api/src/auth/router.ts:12). Ten attempts per minute are tracked in an in-memory map keyed by request IP. There is no username dimension, shared store, or eviction of inactive address keys.

**Impact:** distributed sources can exceed a username's intended protection; users behind one NAT may throttle one another; restarts/multiple processes reset or multiply limits. An unbounded address map is also avoidable memory growth. These were not load-tested.

**Remediation:** combine bounded IP and normalized-account controls, shared enforcement where needed, expiry/eviction, AD-aware lockout handling and useful audit alerts. Avoid a simplistic account lockout that enables denial of service against named users.

### F12 — Medium · Confirmed, reproduced · Trend changes the requested date range

**Evidence:** [insights.ts:192](C:/SupplyChain/apps/api/src/modules/reports/insights.ts:192), lines 196 and 215; [reports/router.ts:13](C:/SupplyChain/apps/api/src/modules/reports/router.ts:13).

**Validation:** 15–20 September becomes 1–30 September before queries run. A January 2023–September 2026 selection produces only January 2023–December 2024. The UI does mention “at most 24” and displays resulting months, so the cap is disclosed generally; it does not reject an overlong requested range. The date schema validates shape only, not real calendar validity or ordered bounds.

**Impact:** a user comparing Performance for exact dates with Trend can see different cohorts; recent months can be omitted from a long selection. Impossible dates can reach SQL or JavaScript date normalization.

**Remediation:** choose explicit month-picker semantics or intersect boundary months with the exact dates. Reject or visibly normalize ranges over the supported limit, and validate real dates and from ≤ to. Test partial months, leap dates, reversed ranges, month/year boundaries and the cap.

### F13 — Medium · Confirmed query inconsistency · Performance search filters totals but not durations

**Evidence:** [reports.ts:47](C:/SupplyChain/apps/api/src/modules/reports/reports.ts:47), [reports.ts:154](C:/SupplyChain/apps/api/src/modules/reports/reports.ts:154), [reports.ts:224](C:/SupplyChain/apps/api/src/modules/reports/reports.ts:224); [ReportsPage.tsx:61](C:/SupplyChain/apps/web/src/pages/reports/ReportsPage.tsx:61).

The execution summary applies `f.q` to demand numbers, but milestones and diagnostic sections apply company/date criteria without that search. Dashboard and Trend explicitly omit `q` when invoking their children, although the global search remains visible.

**Impact:** a filtered Performance screen can combine demand-specific quantities/rates with company-wide cycle and on-time measures. A search can appear to do nothing on Dashboard/Trend without a clear local explanation.

**Remediation:** use a shared eligible-demand scope where a filter is supported, or hide/disable search and state its scope on tabs that do not support it. Add a two-demand fixture with sharply different durations and verify filtering consistently.

### F14 — Medium · Confirmed historical-measure issue · Supplier response time changes when quotes are revised

**Evidence:** [insights.ts:111](C:/SupplyChain/apps/api/src/modules/reports/insights.ts:111), [insights.ts:173](C:/SupplyChain/apps/api/src/modules/reports/insights.ts:173); [quotes.ts:76](C:/SupplyChain/apps/api/src/modules/rfq/quotes.ts:76). `MIN(RecordedAt)` is computed only over current quotes. Replacing a quote sets the previous row non-current.

**Impact:** if all the earliest quote rows are replaced, the apparent first response moves later, penalizing the supplier for revisions. The field also measures internal recording time, not necessarily when a supplier actually replied. This was established from code; no quotes were modified.

**Remediation:** preserve the first valid received/recorded event independently of the current commercial offer, and label the measure accurately. Test a first quote followed by a later replacement and multiple lines.

### F15 — Medium · Confirmed historical-definition risk · Accepted-flow chart uses current container counts

**Evidence:** [dashboard.ts:224](C:/SupplyChain/apps/api/src/modules/reports/dashboard.ts:224), especially the accepted query at lines 233–235. The chart buckets a demand by original AcceptedAt but sums current DemandWeek.ContainerCount.

**Impact:** later additions, cancellations or merges can rewrite the displayed historical intake rather than show what entered the process in that week. This is a confirmed query-definition mismatch if the intended measure is acceptance-time flow; a business definition decision is required. No historical record was changed to demonstrate it.

**Remediation:** use the accepted baseline/version or acceptance event for initial intake, then show subsequent approved changes separately. Reconcile intake + changes − ordered/cancelled against backlog using a documented container accounting rule.

### F16 — Medium · Confirmed scalability design · Full reports run for counts and page in memory

**Evidence:** [ReportsPage.tsx:39](C:/SupplyChain/apps/web/src/pages/reports/ReportsPage.tsx:39), lines 98 and 164; [ArrivalsTab.tsx:50](C:/SupplyChain/apps/web/src/pages/reports/ArrivalsTab.tsx:50); [reports.ts:31](C:/SupplyChain/apps/api/src/modules/reports/reports.ts:31); [insights.ts:24](C:/SupplyChain/apps/api/src/modules/reports/insights.ts:24).

Opening Reports fetches execution, CR register, arrivals and the seven-query supplier scorecard to populate tab labels even when only Dashboard is viewed. These datasets are not SQL-paged and several allow unrestricted history. Client slicing reduces visible rows, not database, network or memory work.

**Impact:** more users and data multiply unnecessary work and compete with workflow commands for the pool. Current small-data timings are acceptable but do not remove this scaling risk.

**Remediation:** use cheap count/summary endpoints or omit expensive counts; load detailed tabs on demand; paginate/filter in SQL; use bounded asynchronous export for large extracts; cap report ranges server-side. Preserve separate lightweight headline aggregation. Reset/clamp page state after filters change—current report page state is independent of filters, creating a plausible empty-page edge case that was not browser-reproduced.

### F17 — Medium · Confirmed contract gap and contention risk · Idempotency key does not bind the request

**Evidence:** [command.ts:15](C:/SupplyChain/apps/api/src/modules/workflow/command.ts:15), lines 18, 30 and 34. Stored commands check user ID but not stored command name, target or input hash. A reused key by the same user returns the previous result before the new service body runs. Missing command IDs are also read with `UPDLOCK,HOLDLOCK` for the whole business transaction.

**Impact:** accidental key reuse across different operations can report success without executing the requested operation. Range locking on absent keys can serialize otherwise unrelated commands, particularly in sparse/empty key ranges. Neither a concurrency benchmark nor an authorization exploit was claimed.

**Remediation:** bind the idempotency key to user, operation, target and canonical request hash; reject mismatches. Design an atomic claim/replay protocol and benchmark contention. Do not remove locking without preserving duplicate protection. Define retention in relation to retry windows before deleting old command results.

### F18 — Medium · Risk · Purge is not fenced against background/external work

**Evidence:** [purge.ts:66](C:/SupplyChain/apps/api/src/modules/ops/purge.ts:66), lines 68–89; [server.ts:104](C:/SupplyChain/apps/api/src/server.ts:104); [ops/router.ts:15](C:/SupplyChain/apps/api/src/modules/ops/router.ts:15). Purge commits database deletion, resets document sequences, then deletes content-addressed files. There is no visible shared maintenance fence for writers/outbox calls, and the preview/file list is read before the transaction.

**Impact:** an in-flight SAP call can complete after its tracking data disappears; reused portal references can collide with external test-system history; a same-content upload after commit can reference a file about to be deleted. These depend on concurrent activity and were not triggered. The explicit PURGE confirmation and production refusal are useful existing controls.

**Remediation:** quiesce/fence all writers and workers, require no unresolved external submissions, isolate development SAP namespaces, and coordinate file cleanup with generation/reference checks. Prefer an explicit dev-only allow flag over treating every non-production environment value as eligible. Never exercise this on shared data to test the hypothesis.

### F19 — Medium · Observed deployment gap · Database patch level and observability require attention

The catalog reports **SQL Server 2016 SP1, 13.0.4001.0**, compatibility 130, FULL recovery, read-committed snapshot off, snapshot isolation off and Query Store off. The build is the 2016 SP1 baseline and substantially behind the releases listed in Microsoft's [SQL Server 2016 build history](https://learn.microsoft.com/en-us/troubleshoot/sql/releases/sqlserver-2016/build-versions). No specific unpatched exploit or production support entitlement is asserted here.

**Impact:** platform maintenance risk, weaker query regression visibility, and reader/writer blocking under workload. FULL recovery alone is not proof of working log backups or recoverability.

**Remediation:** DBA-led patch/upgrade and support review; evaluate Query Store and RCSI on a restored isolated database, including tempdb/version-store capacity and concurrency tests. Validate full/log backup cadence, restore drills and agreed RPO/RTO. No database settings were changed.

### F20 — Medium · Confirmed assurance gap · Tests do not independently prove headline correctness

**Evidence:** [po.spec.ts:214](C:/SupplyChain/apps/api/test/db/po.spec.ts:214), [timeReports.ts:19](C:/SupplyChain/apps/api/src/scripts/timeReports.ts:19), [vitest.config.ts](C:/SupplyChain/apps/api/vitest.config.ts). Existing DB tests check execution quantities, then primarily assert that Performance rates/stages are present. Trend-versus-Performance comparison shares `headlineOf`, so both can agree while both are wrong. No `.github` CI directory was present in the checkout; external CI was not inspected.

**Remediation:** independent golden business scenarios asserting every quantity/KPI, fractional units, dates and mixed currencies; dedicated SAP anomaly/race tests; company-boundary tests for each route family; isolated test databases per run. Add CI typecheck/unit/integration/security checks and policy checks for ledger writes. Unit-test success should not be interpreted as end-to-end acceptance.

## 4. Database and performance assessment

### Current evidence

The current catalog inventory lists approximately 446 demands, 630 quantity slices, 1,175 slice-history rows, 7,539 command-log rows, 14,942 materials and 2,537 imported POs. These are metadata inventory counts from a development environment, not production volume projections. It reports 29 migration records. All **129 foreign keys** and **64 check constraints** were enabled and trusted. The inventory showed no heap marker for its listed allocated tables. Zero returned invariant violations is reassuring, but only covers the assertions encoded in those scripts at observation time.

| Read-only service call | Observed elapsed time | Returned size |
|---|---:|---:|
| Execution, no date range | 215 ms | 314 rows |
| CR register, no date range | 166 ms | 103 rows |
| Performance, last 12 weeks | 565 ms | 1 unit headline |
| Arrivals, default range | 131 ms | 31 rows |
| Suppliers, default period | 556 ms | 3 suppliers |
| Trend, default period | 281 ms | 12 months |

These are **one sample per function**, after connection initialization, from a local Node process to the configured database as an all-company review actor. They include service/driver/network time, exclude HTTP authentication and browser rendering, and are neither SQL CPU measurements nor p50/p95 values. Queries ran sequentially at the function level; each function may issue concurrent statements internally. Cache state was not controlled. The incorrect F01 quantities can still be returned quickly.

### Design strengths

- SQL pagination is present in the demand and RFQ lists: [demandRead.ts:149](C:/SupplyChain/apps/api/src/modules/demand/demandRead.ts:149), [rfqRead.ts:175](C:/SupplyChain/apps/api/src/modules/rfq/rfqRead.ts:175).
- Migrations 0025–0026 add covering indexes for ledger state, line/RFQ/award/handoff lookups and inbox queries. [Index migration](C:/SupplyChain/db/migrations/0025_performance_indexes.sql:6).
- The milestone query builds split ancestry once in a temporary table instead of repeating ancestor work for every history row. It retains a bounded recursive depth.
- The custom ODBC adapter isolates driver integration; exact quantities are checked for safe-integer conversion. Transactional workflow writes use deadlock retries and row versions.
- SAP network calls are generally outside database transactions, reducing lock duration.

### Remaining performance work

1. Fix F16 before adding more report consumers. Run 1/10/30/50 concurrent readers mixed with submit/award/SAP-sync workloads on an isolated realistic copy. Record p50/p95/p99, timeout rate, pool wait, lock waits, logical reads and CPU separately.
2. Measure the command-log range lock (F17), large reports and full purchase-history rebuild. Do not add every missing FK index blindly: use plans and write overhead to justify each index. User-deletion provenance now scans multiple user-reference columns that the earlier performance review intentionally left unindexed because users were not deleted; reconsider this changed workload.
3. RCSI can reduce reader/writer blocking but requires validation; it does not remove explicit locks or solve inconsistent snapshots across multiple independent report statements. Decide whether each dashboard card needs a single as-of snapshot or simply a displayed refresh time.
4. Size the connection pool relative to Node's worker pool, SQL capacity and measured concurrency. Current configured DB pool is 10. The repository startup wrappers explicitly increase `UV_THREADPOOL_SIZE`; ensure production uses them. Raising the DB pool alone can make blocking worse.
5. Introduce a retention policy for command logs, closed inbox rows, audit/events and orphaned attachment files. Preserve legal/business audit needs and idempotency replay guarantees; a blanket 30-day command deletion is a proposal requiring analysis, not an automatically safe fix.
6. Establish query baselines and maintenance: Query Store, statistics/index monitoring, tempdb monitoring, capacity alerts, backup verification and periodic restore exercises. Historical documentation's 20,000-demand benchmark is useful context but not a substitute for rerunning the current report code at representative volume.

## 5. Code quality and security architecture

The modular API, shared permission catalogue, Zod boundaries, company-aware actors and server-side allowed-action approach should be preserved. Parameterized Kysely SQL predominates. The inspected `sql.raw` uses were mostly fixed fragments, catalog-derived identifiers or internal generated variable names; this review did not establish an SQL-injection path. React rendering avoids an obvious raw-HTML injection path in the searched source. Neither statement is a full injection certification.

Secrets are encrypted with AES-256-GCM and random IVs in [secret.ts](C:/SupplyChain/apps/api/src/settings/secret.ts:1). Session cookies use HttpOnly and SameSite Strict; secure-cookie selection follows the request protocol. Headers include nosniff, frame denial, referrer policy and COOP, with HSTS in configured TLS/proxy mode. Company-scoped workflow reads, child ownership checks and separation-of-duty checks are important strengths. `.env` was not tracked; `.env.example` was. Secret values were not printed or exported by the review.

Further code/security improvements, after the findings above:

- Use nominal/branded types for milli quantities, displayed decimal strings, identifiers and dates. Current structural types allow the F01 mistake despite passing TypeScript.
- Keep transaction access checks and mutations together. User deletion loads its target/admin status before the transaction ([userDelete.ts:77](C:/SupplyChain/apps/api/src/modules/users/userDelete.ts:77)); concurrent role changes can make that decision stale. Validate on a locked current row and test on an isolated database.
- Treat archived users explicitly as inactive in every auth/update path. `loadAuthUser` checks IsActive, not DeletedAt, and `updateUser` can target any existing ID. Archived-account restoration should be a designed operation, with token revocation, rather than an incidental API edit.
- Security audits are best effort and occur after many mutations ([audit.ts:1](C:/SupplyChain/apps/api/src/auth/audit.ts:1)). An audit write failure does not undo a privilege change. Decide which security events require transactional durable recording/outbox delivery and alert on failures.
- `startRun` assumes a sync older than 30 minutes has stopped ([syncRun.ts:23](C:/SupplyChain/apps/api/src/modules/sync/syncRun.ts:23)). A genuinely slow live sync can overlap a new run. Use a heartbeat/lease and ownership checks before recovery.
- Return stable generic messages for unexpected backend errors. Disabling tRPC stack traces is helpful, but its formatter still returns the normal error message shape; audit whether raw driver/upstream text is exposed. This was not dynamically established as a disclosure.
- Add an appropriately tested CSP and deployment-level resource limits. There is no finding of an XSS exploit merely because CSP is absent.
- Separate pure report calculations from SQL orchestration and UI formatting. Keep metric definitions in one tested domain module. Most service files are reasonably bounded; the large schema type file is a less concerning exception than repeating accounting/filter logic across reports.

## 6. Functional gap analysis

The approved-spec process in `CLAUDE.md` explicitly requires agreement before adding features. Items below are proposals or readiness gaps; they are not authorization to implement them.

| Capability | Current position | Required decision / acceptance evidence |
|---|---|---|
| Demand → RFQ → award → handoff → PO | Substantial implemented workflow, state/ledger checks and test coverage | End-to-end UAT with realistic departments, returns, changes, partial quantities and concurrency |
| Real SAP PO integration | Generic configurable adapter; repository backlog says field mapping/contract remains pending | Agreed field/reference contract, idempotency and lookup guarantees, credentials/transport, test-system fault suite |
| Notifications | Outbox exists; delivery is listed as backlog work | Delivery channel, ownership, retries, deduplication, opt-outs and failure visibility |
| Supplier/material eligibility | PO validation checks freshness and material existence; plant-level purchasability is explicitly deferred | Validate company/plant purchasing rules with SAP data; confirm freshness enforcement at invite/award |
| Partial cancellation vs containers | Backlog acknowledges quantities may shrink without corresponding container-count adjustment | Define shipment/container accounting so planning and KPI totals remain meaningful |
| Existing/open balances | Cutover documents exist; opening-balance loader/reconciliation remains backlog | Reconcile open demands, awards and SAP commitments before using the app for live work |
| Draft/test-data lifecycle | Dev UI contains many test-related records; granular discard/archive is backlog | Isolated UAT data, draft discard/archive, data-retention policy; avoid using global purge as routine cleanup |
| Audit administration | Audit records exist; browser/operational access is a follow-up | Searchable audit viewer, export policy, retention, privileged-action alerts |
| Operational recovery | Runbooks/checklists exist | Evidence of restore drill, secrets recovery, worker restart/reconcile drill and owners/on-call escalation |
| Authorization model | Workflow permission + company model; master PO gap in F05 | Explicit master-data/commercial-data scope and least-privilege role matrix |
| Product acceptance | Some screen specs still say waiting for acceptance | Signed UAT acceptance per screen; do not infer acceptance from passing tests |

## 7. Layout and user experience evaluation

### Observed strengths

The approximately 1,520-pixel-wide desktop screenshot showed a consistent dark header, grouped navigation, restrained green status accents and a compact working area. Dashboard cards clearly distinguish “now” and “period,” explain unit separation, offer chart/table alternatives, and provide demand/RFQ links. Arrivals includes an explicit note that shipment containers repeat across material rows. Saved column/page preferences are a useful fit for operational users.

### Observed issues and actionable improvements

| Area | Evidence / assessment | Proposed enhancement and validation |
|---|---|---|
| Report hierarchy | Dashboard is long; headline KPIs appear below large queue, shipping and waiting-RFQ sections | Put a concise exception summary and trusted headline measures first; use role-oriented default card order and progressive detail. Validate time to identify the next action with Sales/Procurement users |
| Dense tables | Arrivals at desktop width visibly truncates “Confirmed ETD” and “Company”; status and material compete for width | Default to fewer task-critical columns, group shipment and material detail, show complete accessible column labels. Keep the approved no-sideways-scroll preference by moving secondary detail into drawers |
| Numeric comparability | The live headline and stability totals disagree by 1,000 (F01) | Resolve accounting first, then add a reconciliation drill-down and definitions beside each measure |
| Date semantics | Shared range controls govern acceptance date, CR submission date, ETD week or other cohorts depending on tab; live cards ignore them | Show a compact scope sentence/chip per tab/card: companies, exact cohort date, as-of time and applied filters. Hide unsupported search controls |
| Accessibility | Chart SVGs have role=img but no accessible chart name/description in [Charts.tsx:119](C:/SupplyChain/apps/web/src/components/Charts.tsx:119); execution rows open through onClick without an explicit row action in [ReportsPage.tsx:99](C:/SupplyChain/apps/web/src/pages/reports/ReportsPage.tsx:99) | Add accessible chart names and table equivalents, keyboard-focusable record links/buttons, focus management after drawer close, and keyboard equivalents for hover content. Validate with keyboard and screen reader; not yet certified |
| Readability | Charts hard-code 11/12px text despite app-wide appearance settings; secondary explanations are visually subdued | Respect the selected typography scale, shorten notes with expandable definitions and test 125–200% zoom. Measure contrast rather than assuming screenshot colors pass |
| Navigation | Dashboard links do not universally preserve date/company/search context; URL-filter support is already backlog | Encode supported filters in URLs, preserve return context, and offer breadcrumbs on deep records |
| Loading/refresh | Placeholder data can remain while filters change; not all KPI views show a prominent updating state | Show “Updating” and last-successful refresh time; disable stale-context exports until the displayed scope matches the loaded result |
| Responsive detail | Sider has a responsive breakpoint, but HBars reserves 220px labels + 150px values before bar width/gaps | Add a small-screen layout and verify 390/768/1024px widths. This is source-based risk, not a completed mobile test |

Do not claim user preference for a less dense application: the repository explicitly prefers compact screens. Improve hierarchy and reveal detail on demand while preserving that intent. No quantitative usability study or accessibility conformance audit was performed.

## 8. Reports and dashboard enhancement plan

### Correct definitions before expansion

1. Publish a small metric dictionary: name, business owner, grain, source events, unit/currency, numerator/denominator, cohort date, exclusions, refresh time and worked example.
2. Distinguish PO-created execution from actual shipment, delivery and receipt. The current “Arrivals” report contains ETD and award/PO progress, not an observed arrival/receipt event. Rename to a shipment/departure planning label or explicitly state what is estimated until ETA/actual arrival sources exist.
3. Keep current-state backlog, acceptance cohorts and event-period throughput separate. Avoid labeling accepted-cohort outcomes as events that happened during the selected period.
4. Distinguish supplier quote receipt from internal quote entry; separate manual handoff returns from automatic returns. The dashboard supplier query counts all RETURNED handoffs, while its explanatory wording refers to the PO team; the scorecard filters ReturnedBy. Align these definitions ([dashboard.ts:333](C:/SupplyChain/apps/api/src/modules/reports/dashboard.ts:333), [insights.ts:136](C:/SupplyChain/apps/api/src/modules/reports/insights.ts:136)).
5. Show coverage and sample size for percentages and durations. “100% on time” on a tiny or incomplete completed cohort should be visibly qualified. Retain N/A when the denominator is zero.
6. Container shares estimated from raw quantities require a documented common unit within each demand-week. Never proportion across incompatible units without normalization. Check this invariant before treating the shipping estimate as reliable for all future data.

### Prioritized product ideas

| Audience | Enhancement | Decision supported | Prerequisite |
|---|---|---|---|
| Sales | Demand fulfillment exceptions with owner, due date, unsourced quantity and next step | Which customer commitments need intervention today? | Correct quantities, company scope, reliable drill-down filters |
| Procurement | RFQ aging by supplier with first response, revisions and missing quote coverage | Which suppliers should be chased and where is competition weak? | F14 and actual/recorded response definition |
| PO team | Pending/unknown/rejected SAP queue with age, next retry and evidence completeness | Which external transactions need safe manual action? | F02–F04, permissions and clear reconciliation states |
| Management | Cohort completion trend plus period throughput/backlog movement | Is capacity keeping up with demand? | F01/F12/F15 and independent reconciliation |
| Procurement management | Supplier concentration by containers and value per currency, with sample sizes | Are sourcing dependencies or commercial exposures increasing? | Consistent active/cancelled award policy, no cross-currency sums |
| Process owners | Stage duration median/p90, aged open work and completed-work averages | Where are bottlenecks, including work not yet completed? | Event timestamps and a defined open-work aging denominator |
| Sales/logistics | ETD versus confirmed ETD variance, missing dates and later actual ETA/receipt | Which plans have slipped and what is genuinely arriving? | Reliable logistics source; do not invent arrival data |
| Administration | Data freshness, query/service health, audit failures and backlog delivery health | Can users trust today's data and automation? | Operational telemetry and owners |

### Export safeguards

Add a metadata sheet with company scope, exact period semantics, generation/as-of time, units and definitions. Export shipment-level container totals separately from material rows so Excel users do not accidentally sum repeated containers. Prefer per-column cell typing: [excel.ts:6](C:/SupplyChain/apps/web/src/lib/excel.ts:6) currently converts any numeric-looking string without a leading zero into a number, which can lose precision for future long identifiers. Preserve identifiers as text and quantities/prices as numbers with explicit formats. Large exports should be bounded/background operations rather than loading all records solely to export in the browser.

## 9. Prioritized remediation roadmap

Effort bands are planning estimates, not commitments: **S** roughly a focused change/test set, **M** several related components or scenarios, **L** cross-system/deployment work. Final effort depends on approved business definitions and the SAP contract.

| Sequence | Work package | Suggested owner | Effort | Exit criterion |
|---|---|---|---|---|
| 1 | F01 quantity correctness and F20 independent report fixtures | Backend + QA | S–M | Exact totals and fractions match independently calculated ledger expectations across all three surfaces/exports |
| 2 | F02 lookup contract; F03 outcome fencing; F04 leases | Integration + backend + QA | M–L | Fault/race suite proves no unsafe resend, no reopening settled drafts and explicit late-reply handling |
| 3 | F05 PO company scope and F06 activation authorization | Security + backend + business owner | M | Negative tests for cross-company detail and higher-privilege role activation pass |
| 4 | F07 sessions, F08 transports/proxy, F09 dependencies, F10/F11 resource/login controls | Platform + security | M–L | Revocation, topology, secure upstreams and dependency applicability documented and tested |
| 5 | F12–F15 period, search, supplier and historical-flow definitions | Product + reporting + QA | M | Signed metric dictionary and boundary/revision golden fixtures |
| 6 | F16/F17 performance and idempotency contracts | Backend + DBA | M | Representative concurrent workload meets agreed p95/error objectives with query evidence |
| 7 | F18 maintenance fencing and F19 platform/restore readiness | Platform + DBA | M–L | Isolated recovery/purge drills, patch plan and restored backup verified |
| 8 | UX/accessibility, export metadata and prioritized reporting ideas | Frontend + users | M | Task-based UAT, keyboard/zoom/mobile checks and signed screen acceptance |

### Production release gates

- No unresolved high-impact accounting or SAP outcome defects.
- Real SAP test-system contract, idempotency, timeout and reconciliation evidence approved by its owner.
- Least-privilege/company-boundary and session-revocation tests pass; development bypasses disabled.
- Production TLS/proxy/upstream trust and runtime service identities verified; sensitive keys recoverable and access-controlled.
- Representative performance test and current-query baseline recorded; no claim based solely on old benchmark documents.
- Backups and recovery are demonstrated, including attachments and encryption keys, with agreed RPO/RTO.
- Business UAT covers realistic departments, changed/rejected/partial workflows and cutover reconciliation.

## 10. Reproduction and evidence guide

The external probe scripts import application modules without editing them. From `C:\SupplyChain`, the pure probe can be run with `node --import tsx <absolute-output-path>/review-pure-probes.mts`; the SAP probe similarly uses `review-sap-probe.mts` and only an ephemeral localhost mock. The DB probe uses `--env-file=.env` plus `review-db-probes.mts`; it reads the configured database and must be reviewed before use in a different environment. The existing inventory script is `apps/api/scripts/perf/inventory.ts`.

For F01, compare the saved pure-probe input/outputs and live headline/stability observations. For F02, inspect `sap-probe-results.txt`. For database configuration, counts, constraints and report timings, use `database-inventory.txt` and `database-probe-results.txt`. For dependency findings, use the audit JSON and maintainer advisories linked in F09. The isolated probe scripts are review aids, not application fixes or a replacement test suite.

The earlier documents under `docs/review` and the backlog helped identify intent and already-known limitations. Their claims were treated as historical evidence, not as new tests performed here. This review adds current reproduction of the quantity and SAP lookup defects, fresh database/invariant observations, and a consolidated remediation plan.

**Completion:** all seven requested review areas are addressed. No fixes, migration, purge, dependency update, business-data edit, role change or SAP submission was performed. Implementation remains subject to explicit user approval.
