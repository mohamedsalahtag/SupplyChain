# 13 · Demands (list)

**Status:** Accepted 2026-09-24 (Stage 1 of the Demand-to-PO plan v5).

## Purpose
Find any demand of your companies and see its status and quantities at a glance.

## Users
Everyone with `demands.open`. Only demands of the user's companies are listed.

## Main path
1. Menu **Purchasing → Demands**.
   - Everyone starts on **All in my companies**, so Sales follows every demand of its companies, whoever created it; **Mine** narrows to their own (revision 2026-09-24).
   - Everyone else starts on **All in my companies**.
2. Filter, then click a row to open the demand (spec 12).
3. **New demand** (with `demand.create`) creates a draft and opens it.

## Columns (`AppTable`, key `demands`)
- Number, Company, Status (tag), Created by, Created at
- Submitted (first submission), ETD weeks (e.g. "W14–W16")
- Containers (sum of week counts), Lines
- Requested and Open, per unit (e.g. "7,000 CT · 1,200 KGM"; units are never added together)
- Hidden by default: Accepted at, Current version

Sorted by number, newest first.

## Filters
- **Mine / All in my companies** switch
- Search: number or material text
- Company, Status (both multi-select)
- ETD week from–to

## Loose-end check
| Question | Answer |
|---|---|
| Procurement's "demands to accept" | My work → *Accept demand* tab. Here: Status = Submitted. No separate inbox screen (one screen per job). |
| A demand of another company | Never listed; opening its link answers "not found". |
| Status of a draft | The workflow status (Draft / Submitted / Returned); after acceptance, the status worked out from quantities (spec 12). |

## Out of scope (backlog)
- Excel export of the list.
- Saved filters.

Permissions: `demands.open` (list and view), `demand.create` (New demand button).

Mockup: `docs/mockups/stage-1.html` (page "Demands").

## Progress, Waiting on and What's left (2026-09-29, mockup `docs/mockups/demand-progress.html`)
Built at the user's request because "50% on PO · 50% awarded" did not say whether Procurement still had work.
- **Stages** (one server definition, `modules/demand/progress.ts`): open · in RFQ (incl. quoted) · awarded (**Procurement** to hand off) · handed off (**PO team** to accept) · PO preparation (**PO team** to submit) · on PO · on PO (simulated — the draft's reference is in `scm.StubSapPo`) · cancelled. Each has its own colour; the bar's hover says whose turn each part is.
- **Waiting on** (Demands list column and `MultiFilter`): Procurement / PO team / Sales / Nobody, with the action ("accept HO-000027", "submit POD-000006", "acknowledge AB-000051 (optional)"). The filter and the column use the same SQL (`waitingSql`), so a demand found by the filter always shows that team. Procurement: submitted demand to review, open / in RFQ / awarded quantity, a Sales query on an award, a Sales change request to decide. PO team: handed-off or PO-preparation quantity, a PO draft with an unknown SAP outcome. Sales: draft or returned demand, an award not acknowledged (optional), a Procurement change request to decide. Nobody: accepted and none of these.
- **Demand page:** "Now" shows the bar and the stage shares; "Who has it" names the teams (and "Procurement has nothing left to do" when so); "Next" lists their actions; the step bar reaches *Ordered (PO)* once nothing waits on Procurement to hand off. **What's left** (`demand.progress`): one row per unfinished part — not in an RFQ yet, per RFQ, per award × supplier (handoff, PO draft, SAP PO), Sales acknowledgements, open change requests — with where it is, who acts next and a link; the card says *Procurement: nothing left to do* when no row is Procurement's.

