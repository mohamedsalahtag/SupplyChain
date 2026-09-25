# Roadmap: what is done, Stage 9, and the road to production (2026-09-25)

## Where we are
| Stage (plan v5) | State |
|---|---|
| 0 Foundations · 1 Demand · 2 Change requests · 3 Merge · 4 RFQ · 5 Award · 6 Handoff | Built and **accepted** |
| 7 PO and SAP outbox | Built. Waiting for acceptance. Sends to the **simulator** until the company's PO API is entered in Configuration → SAP purchase orders. |
| 8 Reports (Excel export) | Built. Waiting for acceptance. |
| 9 Deferred items | **Not built**: see below; most items need input from SAP or IT first |
| 10 Production readiness | Tools and documents built; the drills (restore, UAT, pilot) still have to be **run** |

## Stage 9: the deferred items
The plan puts these in Stage 9 "design later": each needs a decision or a system outside the app before it can be built.

| # | Item | What it means | What exists today | What is needed to build it | Priority |
|---|---|---|---|---|---|
| 9.1 | **Real SAP PO adapter** | Purchase orders are created in SAP for real | Frozen payload, outbox, lookup by reference, manual resolution, the simulator, **Configuration → SAP purchase orders** and a generic HTTP adapter (POST create, GET lookup) | **Your PO API**: address, a sample request and reply, error format, login. With it, only the field mapping (`toSapBody`) is written, then the Stage 7 fault tests are run against the SAP test system | **Blocks production** |
| 9.2 | **SAP field for the portal reference (POD-…)** | SAP stores the portal's draft number on the PO, so a lost reply can be checked | The field name is configurable (Configuration → SAP purchase orders) | The SAP team adds or chooses the field (e.g. a Z-field or `YourReference`), and the lookup service filters on it | **Blocks production** |
| 9.3 | SAP field for the demand reference | The SAP PO item shows which demand it came from | The portal keeps the link internally (PO item → award item → demand line) | The SAP team chooses the field; then it is one line in the mapping | Nice to have |
| 9.4 | Notification delivery (e-mail / Teams) | People get an e-mail or a Teams message when something lands on their My work | Every event is already written to `scm.NotificationOutbox`; My work shows everything in the app | An SMTP relay (address, sender) or a Teams webhook from IT, and the list of events worth an e-mail. About 2–3 days to build. | High after go-live |
| 9.5 | Changes after the PO is created | Change or cancel quantity on a PO that exists in SAP | Rule today: the PO team changes the PO in SAP by hand and writes it as a comment on the PO draft. The portal never changes PO-created quantity. | The SAP change and cancel API, and the business rules (who may change what, and whether Sales must agree) | Medium |
| 9.6 | Supplier self-service quoting | Suppliers enter their quotes in a portal themselves | Procurement sends the supplier view (Excel) and records quotes, with attachments as evidence | A separate external-facing site: supplier accounts, internet exposure and security review. A project of its own. | Later |

## What is needed from you (and IT / the SAP team)
1. **The PO API** (9.1): URL, method, a sample request and reply, error format, login (user or technical account), test system access.
2. **The SAP reference field** (9.2): agreed with the SAP team.
3. **A server** for production and one for UAT, the **TLS certificate** for its name, a **service account**, and an **empty production database** (see `docs/operations/production-setup.md`).
4. **An SMTP relay or Teams webhook**, if e-mails are wanted (9.4).
5. **Key users** for UAT: one per role (Sales, Procurement, PO team), and a date.
6. **Pilot scope**: which company and which category go first.
7. **Opening balances**: confirm the plan in `docs/operations/cutover.md` (start empty; finish in-flight demands the old way). Otherwise a migration loader is needed (backlog 35).
8. **Decisions still open** (in the backlog):
   - 22: how containers follow a partial cancellation of awarded quantity
   - 24: payment-term descriptions
   - 30: which extra KPIs matter

## Next steps, in order
1. **Accept Stages 7, 8 and 10** (specs 23–25): try them in the app. The UAT script walks through them.
2. **Send the PO API details** (9.1, 9.2). The field mapping is then written and tested against the SAP test system with the fault suite.
3. **Set up the UAT server** (production-setup.md, with `ALLOW_SAP_STUB=true` until the API is ready). Run the **restore drill**, then **UAT** with the key users.
4. **Production server** with HTTPS. Run the go-live gate in cutover.md. **Pilot**: one company and one category, 2–4 weeks.
5. After go-live: notifications (9.4), then the backlog items the pilot shows matter most.
