# Cutover, pilot and rollback

## Go-live gate: all must be true
- [ ] **The company's PO API** is entered in Configuration → SAP purchase orders, with the field mapping adapted to its contract, and tested against the SAP test system with the Stage 7 fault suite. The field that stores the portal reference (POD-…) on the SAP PO is agreed with the SAP team. *(Stage 9.1/9.2: waiting for the API details.)*
- [ ] `.env` on the live server:
  - `NODE_ENV=production`
  - `ALLOW_TEST_LOGIN=false`
  - `ALLOW_VIEW_AS=false`
  - `SERVE_WEB=true`
  - HTTPS (`TLS_PFX_FILE`, or `TRUST_PROXY=true` behind a proxy)
  - `ALLOW_SAP_STUB` unset

  The server refuses to start otherwise, and refuses to submit POs to the simulator. See production-setup.md.
- [ ] Restore drill done (backup-restore.md).
- [ ] UAT signed off by Sales, Procurement and the PO team (uat-script.md).
- [ ] The users are registered, each with **roles and companies**. Operations status shows no separation-of-duties conflicts and no users without a company.
- [ ] Configuration is complete:
  - companies (plant, purchasing org and group)
  - reason codes
  - the origin map
  - shipping terms: Incoterms, ports, payment-term descriptions
  - workflow settings (due times, `masterDataMaxAgeHours`, `kpiOnTimeDaysBeforeEtd`)
- [ ] The three SAP syncs are fresh.
- [ ] Test data is removed. The dev database has many "Automated test — ignore" demands; production starts empty.

## Opening balances (what already exists in SAP / Excel on day 1)
The app starts **empty** (clean slate). Recommended:
1. **Open demands not yet sent for quotation:** Sales enters them in the app as new demands (version 1 = baseline).
2. **Demands already quoted or awarded outside the app:** finish them the old way. Do not migrate half-way states; there is no loader, and hand-made slices would break the ledger invariants.
3. **POs already in SAP:** they arrive through the purchase-order sync (history for the supplier shortlist). They are not linked to demands.

The KPIs therefore start from the go-live date. Say this in the first management report.

## Pilot
- **One company and one category first**, for example company 1000 and Apples, for 2–4 weeks, with named key users.
- Run the daily check (Operations status) and the weekly invariant run.
- Exit criteria:
  - no open defects of severity High
  - every PO of the pilot created in SAP exactly once
  - users sign off

## Rollback
The app writes to SAP only through the outbox (POs). To roll back:
1. Stop the API service.
2. Let the PO team finish the open handoffs manually in SAP. The **PO drafts & SAP** list and the handoff snapshots give them everything they need.
3. Keep the database read-only for reference.

There is nothing to undo in SAP beyond the POs already created, and those are real POs.
