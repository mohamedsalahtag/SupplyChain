# Operations (plan v5 Stage 10)

These are the documents for running the Demand-to-PO app beyond the developers' machines. Written 2026-09-25; review them with IT before the pilot.

| Document | For | What it covers |
|---|---|---|
| [production-setup.md](production-setup.md) | IT | Installing the server: HTTPS, `.env`, Windows service, first configuration, updates |
| [../roadmap.md](../roadmap.md) | Everyone | Stage 9 in detail, what is needed from the business / IT / SAP, next steps |
| [runbooks.md](runbooks.md) | Support (PO team lead, IT) | SAP outcome unknown, SAP rejected, late SAP reply, master data missing or stale, overdue work, worker stopped, sign-in problems |
| [backup-restore.md](backup-restore.md) | IT / DBA | What to back up, the restore drill, and what the outbox does after a restore |
| [cutover.md](cutover.md) | Project team | Go-live checklist, opening balances, the pilot, rollback |
| [uat-script.md](uat-script.md) | Key users (Sales, Procurement, PO team) | Scripted acceptance tests per role, with expected results and sign-off |
| [security-checklist.md](security-checklist.md) | IT security | Server settings, TLS, accounts, separation of duties, review findings still open |
| [training.md](training.md) | Trainers | Training plan per role and the talking points |

## Support model (proposal)
| Level | Who | Handles |
|---|---|---|
| 1 | PO team lead / Procurement lead | "Where is my demand?": My work, statuses, the Reports demand drawer. SAP rejected, master data requests. |
| 2 | IT application support | SAP outcome unknown in *Needs a person*, stale syncs, sign-in and roles, the Operations status page. |
| 3 | Developers | Data fixes (never by hand in the database without an invariant run), defects. |

## Daily monitoring
Open **Administration → Operations status** every morning. Everything should be green:
- **SAP outbox:** *Needs a person* is 0, and the oldest waiting item is under 10 minutes old.
- **Master data:** all three syncs are *fresh*.
- **Overdue work:** follow up with the owner.
- **Users and roles:** no separation-of-duties conflicts, and no users without a company.
- **No test-switch banner.**

Weekly, run the invariant checks (`tests/invariants/*.sql`) read-only against production with SSMS. Every query must return 0 rows; any row is a data defect for level 3.

## Performance targets (proposal, to be confirmed with a load test)
| Action | Target (company network) |
|---|---|
| Open My work, lists, a demand | under 2 s |
| Award up to 50 containers | under 5 s |
| SAP outbox: submit → created (SAP up) | under 1 minute |
