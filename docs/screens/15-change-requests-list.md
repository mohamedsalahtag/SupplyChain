# 15 · Change requests (list)

**Status:** Accepted 2026-09-24 (Stage 2 of the Demand-to-PO plan v5).

## Purpose
Find any change request of your companies: the ones you raised, and their outcome.

## Users
Everyone with `crs.open`, for their companies.

## Main path
1. Menu **Purchasing → Change requests**. It starts on **All in my companies**; **Raised by me** narrows to your own (revision 2026-09-24).
2. Click a row to open the CR (spec 14).

Requests waiting for **your decision** are on **My work → Decide change request**. They are not a second list here (one screen per job). A request you raised never appears there for you.

## Columns (`AppTable`, key `change-requests`)
- Number, Demand, Company, Type, Raised by, Raised at
- Reason
- Status (Submitted / Approved / Partially approved / Rejected / Withdrawn / Blocked)
- Apply status
- Decided by, Decided at
- Hidden by default: Comment, Response time (hours)

## Filters
- **Raised by me / All in my companies** switch
- Search: CR or demand number
- Type, Status and Company (all multi-select)

## Out of scope
- The CR register report with quantities (Stage 8).

Permissions: `crs.open`.

Mockup: `docs/mockups/stage-2.html` (page "Change requests").
