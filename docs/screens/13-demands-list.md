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
