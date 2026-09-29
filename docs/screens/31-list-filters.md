# 31 · Filter section of every list

**Built 2026-09-29 from the approved mockup `docs/mockups/list-filters.html`** (the user added: sub-major choices follow the chosen majors).

- **One component** (`apps/web/src/components/ListFilters.tsx`, `useListFilters(fields)`): the search box stays in the toolbar; every other filter sits in a **Filters** section that starts **collapsed** and opens under the toolbar (`AppTable beforeTable`).
- **Apply** (or Enter) applies; nothing changes while you pick. **Clear all** removes every filter; **Close** keeps what is applied. The Filters button shows how many are applied; each applied filter is a chip (× removes it).
- **Fields:** *multi* — multi-select with search (all dropdowns), optionally **dependent** (`parentKey`: e.g. Sub-major lists only the sub-majors of the chosen majors, and drops choices whose major is removed); *weeks* — ETD week from / to (ISO weeks, labelled with their Monday); *dates* — a date range.
- **Applied filters live in the page address**, so they survive opening a record and coming back, and a filtered list can be bookmarked (backlog 37). Tabs keep them (My work, PO drafts).
- **Choices come from the server** per list (`<module>.filterOptions`): only values that occur in the user's companies' records.

| List | Filters |
|---|---|
| Demands | Stage · Waiting on · Major · Sub-major · Origin · ETD week · Created by · Submitted · Company (+ Mine / All) |
| RFQs | Stage · Waiting on · Supplier (invited, quoted or awarded) · Origin · Major · Sub-major · ETD week · Created by · Company |
| Awards | Waiting on · Sales acknowledgement · Supplier · Origin · Major · Sub-major · ETD week · Currency · Awarded · Company |
| Handoffs | Status · Supplier · Without Sales acknowledgement · ETD week · Sent · Company |
| PO drafts | Status · Supplier · SAP or simulator · Submitted · Company |
| Change requests | Type · Status · Raised by · Reason · Submitted · Company (+ Raised by me / All) |
| Purchase orders (SAP) | Order type · Supplier · Major · Sub-major · Order date · Company |
| Materials | Major · Sub-major · Group · Origin · Material type · In SAP |
| Suppliers | Group · Country · Currency · Origin · Blocked · Purchasing org |
| My work | Company · Due (multi) · Item type · Raised by |
| Users | Role · Status · Company |

**Status and progress in one column** (user decision 2026-09-29): in the Demands and RFQs lists the Progress cell shows the bar, led by the status tag when the bar cannot say it (demand: draft, waiting for Procurement, returned, merged, closed, cancelled; RFQ: draft, closed, cancelled). The status filter is called **Stage**. Record pages keep the status tag beside the title.
