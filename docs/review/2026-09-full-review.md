# Full application review — Demand-to-PO (2026-09-25)

**Scope:** the whole app in `C:\supplychain`: API, web, database, tests and docs. It covers six views: code, interface, user experience, security, permissions, and a gap analysis against `Demand_to_PO_Execution_Plan_v5.md`.

**Method:** four independent read-only reviews (code, security and permissions, interface and UX, gap analysis). Each finding was checked against the code. The fixes were then made, tested and documented in the same session. Test results are at the end.

## 1. Summary

| View | Verdict | Fixed now | Still open (backlog) |
|---|---|---|---|
| Code | **Good structure, a few dangerous edges.** Thin routers, one command wrapper, exact quantities, 27 invariant files. The SAP outbox had race paths that could create a second PO. | Outbox races, SAP call inside a transaction, submit/return race, SQL Server 2016 incompatibility, report accuracy | Duplicated helpers, `openInbox` race, UTC week, see §3 |
| Interface | **Consistent where spec 21 applies; uneven elsewhere.** | Error vs not-found pages, a crash guard (error boundary), plain words for SAP outbox codes, report tables as `AppTable` | Breadcrumbs, date formats, CR statuses in the shared file |
| User experience | **The main flows are guided; some one-way actions had no confirmation.** | Stale-save overwrite (a data-loss bug), confirmation on Submit to SAP and on Decide, rejected PO dead end, Sales landing tab, PO preparation feedback | Unsaved-changes warning, keyboard access, reason descriptions |
| Security | **No SQL injection, no cross-company leak** (proven by a new test). There were **escalation paths** through delegated admin keys, and weak production guards. | Delegated admin limited, production start guard, AD/SAP password reuse, health-check leak, security headers, stub fault injection admin-only | **HTTPS is not set up** (infrastructure), session revocation, upload auth order |
| Permissions | **Every procedure is gated; company scope holds.** Separation of duties was only enforced for change requests. | Server-side separation of duties for demand accept and handoff accept; Operations status lists conflicts | — |
| Gap vs plan v5 | **Stages 0–8 and 10 built; Stage 9 deferred by design.** | Stage 10 docs, Operations status, negative-authorization test, specs 23–25 | ZCON adapter (**blocks production**), worked-example test, 5 invariants, CI |

**Production readiness:** the app is ready for **UAT on a test server with the SAP simulator**.

*Update 2026-09-25:* HTTPS is now built in, and production refuses to start without it. **Configuration → SAP purchase orders** and a generic PO API adapter are built. What still blocks production is **the company's PO API details and the SAP reference field** (backlog 26; see `docs/roadmap.md`). The code is on GitHub (`mohamedsalahtag/SupplyChain`, `main`).

## 2. What was built in this round
| Stage | Built | Evidence |
|---|---|---|
| 7 — PO and SAP | PO preparation (SKU pick and split, master-data requests), PO draft (build, validate, submit), SAP outbox (frozen payload, idempotency key, lease, reconcile by reference, manual resolution with evidence), durable SAP stub with fault injection | spec 23; `modules/po`; migration 0021; `po.spec.ts` (4 tests); `e2e/stage-7.spec.ts` |
| 8 — Reports | Demand execution by origin with a demand drawer (lines, containers per week, SAP POs), CR register, performance (rates, quantity-weighted stage times following split lineage, on time, CR / ack / handoff / SAP KPIs), CSV export | spec 24; `modules/reports`; migration 0022; reports test in `po.spec.ts`; `e2e/stage-8.spec.ts` |
| 10 — Readiness | Operations status page; negative-authorization test (34 procedures); runbooks, backup/restore drill, cutover, UAT script, security checklist, training plan | spec 25; `modules/ops`; `ops.spec.ts`; `docs/operations/` |

## 3. Code review

### Fixed
1. **Possible second SAP PO.** A late reply after an expired lease, or two runners reconciling at once, could overwrite a settled draft.
   - Outcome writes now apply only while the draft is open. A late answer raises a *late SAP reply* exception instead.
   - Reconcile claims its rows, and one run happens at a time per process.
   - Each item is isolated with its own try/catch, and the NOT_FOUND branch is transactional.
2. **SAP lookup inside the resolve transaction** (under lock and deadlock retry). It now runs before the transaction.
3. **Submit vs return race.** Submit now locks the handoff first, the same order a return uses.
4. **Operations query used `STRING_AGG`** and `app.User.IsAdmin`. The first doesn't exist on SQL Server 2016 and the second isn't a column. It is rewritten and now has a DB test.
5. **Reports:**
   - Stage times now cut a parent slice's events at the moment its child split off.
   - The From/To filter now applies to every section.
   - Time-to-acknowledge counts real acknowledgements only.
   - CR register quantities are no longer summed across units.
   - The search escapes LIKE wildcards.
6. **Near-ETD check** skipped open quantity whose ETD had already passed. Those are now kept.
7. **Outbox timestamps** now come from the database (`SYSUTCDATETIME()`).
8. The **file download id** is validated. Expected business errors (404/409/422) no longer fill the error log.

### Open (backlog 34)
- `openInbox` can fail on its unique index when two openers race (rare; a 500).
- The aging job opens and closes items without a domain event, which breaks hard rule 4.
- `isoWeekOf(new Date())` uses UTC, so Monday 00:00–03:00 in KSA still counts as the previous week.
- Partial approvals use increment 1 instead of the unit's increment.
- `containerAward` computes a share with floating point.
- Duplicated helpers: `lockRfq`, reason-code checks, line labels, `HOLD_BLOCKS`.
- `schema.ts` is 489 lines (hand-maintained types), over the 400-line guideline.
- **Nothing is committed to git.** Stages 1–8 exist only on disk. Recommendation: commit on a branch now.

## 4. Interface and user experience

### Fixed
1. **Stale save overwrote another user's work** (demand editor). The editor now keeps the version it started from. A conflict says "Someone else changed this… reload".
2. **Detail pages showed "not found" for any error.** They now show *not found* only for a real 404; other errors show the message and **Try again** (shared `LoadError`).
3. **A missing status label could blank the app.** An error boundary around every route now shows the error and a Reload button.
4. **Submit to SAP** and **Decide change request** now confirm first, with a summary.
5. **PO draft page:**
   - SAP outbox codes are shown in plain words.
   - The key and hash appear on hover.
   - **Process now** is shown only to the PO team.
   - A rejected draft has **Go to PO preparation**.
6. **PO preparation** shows loading and error states, and says why the draft can't be built yet (SKUs to pick, master data).
7. **Sales opens an award on the Acknowledgement tab**; Procurement opens it on Handoff.
8. **Read-only comment panels** no longer invite comments.
9. **Reports:**
   - Both lists are `AppTable`s (saved page size and columns, no sideways scrolling).
   - Change request types and statuses are in plain words.
   - The lines table in the drawer no longer scrolls sideways.

### Open (backlog 33)
- Breadcrumbs: there are three different back-link styles today.
- A warning before leaving unsaved edits (demand, award picks, handoff terms, change editor).
- Reason **codes** are still shown next to their descriptions in pickers and history.
- Keyboard access: list rows open on mouse click only, the award squares are mouse-only, and the header menus are `<a>` without `href`.
- Date-only fields are shown as `YYYY-MM-DD`; unit prices are shown raw.
- Change request statuses have no hover text or "who / next" (spec 21 style).
- Wide modals and drawers have fixed pixel widths.
- My work has no ⋯ menu for the other allowed actions (spec 10).
- Spec drift:
  - The demand and RFQ steps don't reach *Handed off*.
  - Ports are not sorted with the origin country first.
  - Quote documents are missing from Record quotes.

## 5. Security

### Fixed
| # | Finding | Fix |
|---|---|---|
| H2–H4 | `users.add`, `users.edit` and `security.roles.edit` could grant Administrator or any key; each was as strong as admin | Non-admins can give only roles and keys they hold. They can't give an admin role, can't change themselves or an admin, and can't edit a role they hold. |
| H5 / M7 | Changing the AD or SAP address reused the saved password, sending it to the new host | The password must be entered again when the address or account changes |
| H6 | Unsaved AD settings accepted self-signed certificates | Checked in production (`NODE_ENV=production`) |
| M8 | `users.companies.edit` could widen its own scope | Non-admins can't change their own companies, and can give only companies they hold |
| M9 / M10 | SAP stub and fault injection were live with no switch | Fault injection needs `configuration.sap.edit`. Production refuses to start on the stub unless `ALLOW_SAP_STUB=true`. |
| M12 | Separation of duties enforced only for change requests | The server refuses accepting your own demand or your own handoff. Operations status lists users with conflicting keys. |
| M14 | Test sign-in and View as could be on in production | Production refuses to start |
| M16 | Public health check returned database error text | The status only; the detail goes to the log |
| L19 | Unescaped LIKE wildcards | Escaped in awards, RFQs, supplier origins and reports |
| L22 | No security headers | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `COOP` on every reply |
| L29 | Any old attachment counted as evidence for a manual SAP resolution | It must be uploaded after the draft was submitted |

### Open (backlog 32 / security checklist)
- **H1: sign-in over plain HTTP.** Put a TLS proxy in front of the app and serve the built bundle. This is infrastructure, and a **go-live blocker**.
- Sessions can't be revoked before they expire (10 h); disabling a user does work at once.
- The login rate limit is per address and in memory.
- An upload body is read before the session is checked.
- There is no malware scan or CSP.
- The SAP purchase-order history is visible across companies.

### Proven
The **negative-authorization test** signs in a user who holds **every permission** but works for another company. It calls 34 procedures through the real router. All 34 answer *not found*, the lists leave the records out, and nothing changes.

## 6. Permissions

| Role (seeded) | Holds |
|---|---|
| Sales | Demands (create, submit, comment, attach), raise Sales CRs, decide Procurement CRs, acknowledge awards; read awards, handoffs, PO drafts, reports |
| Procurement | Accept, return and merge demands; raise Procurement CRs, decide Sales CRs; RFQs; awards; hand off; read POs and reports |
| PO team | Accept and return handoffs; PO drafts and SAP; read demands, awards, reports |
| Administrator | Everything, including configuration, users, security and operations status |

- Every procedure declares a catalogue key; `trpc.spec.ts` fails otherwise.
- The UI renders the actions the server returns.
- Two mutations rely on inner checks: `cr.decide` is gated by `crs.open`, and `award.comment` by `awards.open`. Both are correct and noted in the code.
- **Demo accounts** hold every company, and `demo.both` holds Sales and Procurement. That is acceptable only because View as is off in production.

## 7. Gap analysis against plan v5

| Stage | Status | Main gaps |
|---|---|---|
| 0 Foundations | Done (adapted) | No CI check that all writes go through `assertBelongs` / `qty.ts`; no deadlock-retry test; no supplier on-demand refresh (backlog 29, 31) |
| 1 Demand | Done (containers revision) | — |
| 2 Change requests | Done (adapted types) | No CR-specific failure-injection test |
| 3 Merge | Done | Company-wide merge list (backlog 16) |
| 4 RFQ | Done | Excel `.xlsx`, inviting suppliers to an existing RFQ (backlog 19–20) |
| 5 Award | Done (by containers) | How containers follow a partial cancellation (backlog 22) |
| 6 Handoff | Done, **accepted** | — |
| 7 PO and SAP | Done with the stub | **ZCON adapter and SAP reference field (backlog 26, blocks production)** |
| 8 Reports | Mostly done | Worked-example test (27); Submit → Accept, time-zone on-time, KPI definitions (30) |
| 9 | Deferred by design | Notifications, ZCON, post-PO changes, supplier portal |
| 10 Readiness | Documents and tools done | Restore drill and UAT to be **run**; migration loader (35); load test; alerts |

**Invariants:** 1–7, 9–12, 14, 15, 17–21 and 24 are complete, plus the extras 15b, 15c and 25–27. **Partial:** 8, 13, 16, 22, 23 (backlog 28).

### Top risks, in order
1. **No real SAP adapter.** Production can't create POs. Agree the reference field with the SAP team now.
2. **Sign-in over HTTP.** Passwords cross the network in clear text.
3. **Nothing is committed to git.** One disk failure loses stages 1–8.
4. **No end-to-end worked example.** The KPI figures are not proven against the plan's table.
5. **No migration loader.** Go-live must start empty (documented in cutover.md).

## 8. Recommended next steps
1. **Commit the work on a branch** (`feature/d2p-stages-1-10`) and set up CI (backlog 31).
2. Accept specs 23–25, then **run UAT** on a test server (`docs/operations/uat-script.md`) with `ALLOW_SAP_STUB=true`.
3. Start **ZCON**: the SAP reference field, then the adapter against the SAP test system, then the Stage 7 fault suite.
4. **HTTPS proxy** and a built bundle on the server, with the security checklist ticked.
5. The **restore drill**, then the pilot (one company, one category).

## 9. Test results (after the fixes, 2026-09-25)
| Suite | Result |
|---|---|
| Typecheck (all workspaces) | Clean |
| Unit | 113 / 113 |
| DB integration + invariants | 102 / 102, including the new tests: the PO/SAP outbox (2), reports, negative authorization (34 procedures) and operations status. Two tests were adjusted for the new separation-of-duties rule and the seeded plant. |
| Browser (e2e) | 35 / 36. Stage 7 passed end to end earlier in the session (SAP PO created after a lost reply). On the final rerun it stops at **Validate** with "SAP data is too old (sap.purchaseOrders)": the dev purchase-order sync has passed the 26 h freshness limit. That is the correct rule; run the sync and rerun `e2e/stage-7.spec.ts`. The first full run had 5 failures caused by the Vite dev server crashing under load; after a restart they pass (see CLAUDE.md). |
