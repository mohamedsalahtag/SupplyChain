# Screen specs

One file per approved screen: `NN-name.md`. A screen is built only after its spec is here.

Each spec contains:

- **Purpose** — one sentence.
- **Users** — who opens it.
- **Main path** — numbered steps, the simple straightforward case only.
- **Process flow** — Mermaid diagram.
- **Loose-end check** — way in / way out, owner, what happens on failure, what happens if two users act at once.
- **Fields and buttons** — exactly what appears.
- **Out of scope** — what is deliberately not included (moved to the backlog).
- **Mockup** — link to the approved clickable mockup.

| # | Screen | Status |
|---|--------|--------|
| 00 | App shell (layout + Home with health) | Built |
| 01 | Materials (read-only list) | Built · waiting for acceptance |
| 02 | Configuration · SAP connection (test + sync) | Built · waiting for acceptance |
| 03 | Configuration · Appearance (app font size) | Built · waiting for acceptance |
| 04 | Configuration tabs, site name, icon; table columns + rows per page; multi-select filters | Built · waiting for acceptance |
| 05 | Sign-in with Active Directory; Configuration → Active Directory | Built · waiting for acceptance |
| 06 | Users (register from AD, roles, active) | Built · waiting for acceptance |
| 07 | Security (roles and permissions) | Built · waiting for acceptance |
| 08 | Suppliers: Z-group choice, sync, Master data → Suppliers | Built · waiting for acceptance |
| 09 | Purchase orders: Z-type + start-date choice, incremental sync, Purchasing → Purchase orders | Built · waiting for acceptance |
| 10 | My work (home): work items and exceptions per user, due / overdue | Accepted |
| 11 | Workflow setup: companies, user companies, reason codes, origin map, workflow settings; supplier / PO sync additions | Accepted |
| 12 | Demand: entry (draft / returned) and Demand 360 (lines & quantities, versions, history, comments, attachments); submit / accept / return | Accepted |
| 13 | Demands list (mine / all in my companies, status, quantities per unit) | Accepted |
| 14 | Change request: raise (Sales: change containers / cancel week / cancel demand; Procurement: not sourced), pre-check, holds, decide per item, apply all-or-nothing | Accepted |
| 15 | Change requests list (raised by me / all in my companies) | Accepted |
| 16 | View as: administrators test the app as demo accounts (Demo Sales, Demo Procurement, both) | Accepted |
| 17 | Merge / unmerge demands (Procurement): weeks or entire demand into a target of the same company; container groups move; Merges tab | Accepted |
| 18 | RFQs (Stage 4a): builder (qty per line and week, containers, origin shortlist ranked by PO history), supplier view, quotes, release / cancel, RFQs list, supplier origins | Accepted |
| 19 | Procurement change requests decided by Sales (Stage 4b): add quantity (+ extra containers), week shift, mix change | Accepted |
| 20 | Award (Stage 5): quote comparison, award batches, shipments (containers, confirmed ETD), un-award, SKU correction, Sales acknowledgement | Accepted (revision 1: award by containers) |
| 21 | Status wording across Demands, RFQs, Awards: who has it, what is next, last step, progress bar, legend, process steps | Accepted |
| 22 | Shipping terms and handoff to the PO team (Stage 6): terms per supplier, readiness, hand off (with/without Sales ack), PO team accept/return, auto-return, Configuration lists, SAP payment terms | Accepted |
| 23 | PO preparation, PO draft and the SAP outbox (Stage 7): SKU picking and split, master-data requests, build / validate / submit, unknown outcomes reconciled by reference, manual resolution with evidence, SAP stub with fault injection | Built · waiting for acceptance |
| 24 | Reports and KPIs (Stage 8): demand execution by business origin (drawer per demand: lines and containers per week), change request register, performance (rates, stage times, on time, CR / ack / handoff / SAP KPIs), CSV | Built · waiting for acceptance |
| 25 | Operations status and production readiness (Stage 10): outbox, master data, overdue work, separation of duties, test switches; runbooks and UAT in `docs/operations/` | Built · waiting for acceptance |
