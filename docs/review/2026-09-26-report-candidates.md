# Reports review and candidate reports (2026-09-26)

**Scope:** the four report surfaces that exist today (Demand execution, Change request register, Performance, and the Dashboard tab of spec 26), what they answer well, where they stop short, and which reports would add real value for Procurement, Sales and management. A candidate is listed only if someone changes a decision after reading it. Nothing here is built; pick from the list and each becomes a spec.

## 1 · What exists, and its limits

| Report | Answers well | Stops short |
|---|---|---|
| **Demand execution** (per demand × unit, with the demand drawer) | What Sales asked for, what reached SAP, what was not sourced, per demand; the baseline and the containers per week of one demand | Only per demand: no view by material, origin, week or supplier; no trend; the drawer is one demand at a time |
| **Change request register** | Every request with reason, decision, response time and quantities | A list, not an analysis: no totals by reason, department, demand or month; no link to what the request cost (returned handoffs, re-awards) |
| **Performance** | Rates per unit (execution, not sourced, on time), stage times, CR / acknowledgement / handoff / SAP figures for one period | One period, one number: no trend month by month, no split by buyer, supplier, origin or company; on-time is quantity-weighted but not visible per supplier |
| **Dashboard** (spec 26) | The live state (ledger, queues, weeks, at-risk lines, RFQs waiting) and the period headline, flow, changes, stability, top suppliers | A snapshot for today; not a place to compare periods, drill to lines, or export |

Two structural gaps run through all four: there is **no trend view** (everything is one period or "now"), and there is **no supplier dimension** beyond containers awarded. The data for both is already in the ledger, the RFQ tables and the SAP purchase-order copy.

## 2 · Candidate reports

Effort: **S** = queries over existing tables, one screen (about a day); **M** = a new aggregation or a new dimension (two to three days); **L** = needs data the app does not hold yet.

### For Procurement

| # | Report | The question it answers | Content | Source | Effort |
|---|---|---|---|---|---|
| P1 | **Supplier scorecard** | Which suppliers to invite, award and watch | Per supplier (period, company): invited / quoted / awarded counts, quote response time (days from Sent to the first quote), quote coverage (rows quoted ÷ rows asked), price position (how often cheapest; average rank), awards above the offer, handoffs returned and why, SKU issues, containers awarded and share. Click → the supplier's RFQs and awards | `RfqSupplier`, `SupplierQuote`, `AwardContainer` / `AwardItem`, `Handoff`, `md.Supplier` | M |
| P2 | **Price history per material and origin** | Are we paying more, and from whom | Per line key (category · sub-category · size · class · origin, optional SKU) and currency: awarded price per month (quantity-weighted), the cheapest quote in each RFQ, the last SAP PO price and supplier, the range between suppliers. Chart per key, table underneath. Never across currencies | `AwardItem`, `SupplierQuote`, `scm.PurchaseHistorySummary`, `md.PurchaseOrderLine` | M |
| P3 | **RFQ effectiveness** | Which RFQs work and which waste time | Per RFQ: suppliers invited vs quoted, days Sent → first quote → award, quantity asked vs awarded vs released, containers offered vs asked, cancelled RFQs and their reasons; totals per buyer and per origin | `Rfq`, `RfqSupplier`, `SupplierQuote`, `RfqLine`, `AwardItem`, `SliceHistory` | M |
| P4 | **Sourcing backlog by reason** | Why quantity is still open, not just how much | Every Open line with days since acceptance and days to ETD, grouped by the reason it is still open: not in an RFQ yet, in an RFQ with no quotes, quoted but not awarded, on hold by a CR, blocked by a missing supplier for the origin. Extends the dashboard's "not yet sourced" card to all weeks with the cause | `QtySlice`, `RfqLine`, `SupplierQuote`, `LineHold`, `InboxItem` (SUPPLIER_MISSING_ORIGIN) | S |
| P5 | **Not-sourced analysis** | Where supply fails | Not-sourced quantity by material, origin, ETD week and reason, with the demands behind it and the share of committed quantity; month by month. Pairs with the not-sourced rate the KPIs already show | `ChangeRequest` (NOT_SOURCED), `ChangeRequestItem`, `QtySlice` (CancelOrigin = PROCUREMENT) | S |
| P6 | **Award changes and rework** | How much sourcing work is redone | Un-awards (keep quotes vs release), SKU corrections, awards above the offer, week shifts, mix changes, handoffs returned — per month, per buyer, per supplier, with reasons | `AwardItemChange`, `Handoff`, `ChangeRequest` | S |

### For Sales

| # | Report | The question it answers | Content | Source | Effort |
|---|---|---|---|---|---|
| S1 | **Arrivals schedule** | What is actually coming, when, from whom | Per ETD week and company: supplier, material, containers, quantity, confirmed ETD, price, PO number and status (awarded / handed off / PO created). The plan Sales can share with customers. Excel export | `AwardShipment`, `AwardItem`, `AwardItemSku`, `PoDraft` | S |
| S2 | **Requested vs delivered week** | Did the fruit come in the week we asked for | Per demand line: requested week, approved week (after shifts), confirmed ETD, days of slip; totals per material and origin; the share of quantity shifted | `QtySlice` (ApprovedEtdWeek), `AwardShipment.ConfirmedEtd`, `ChangeRequest` (WEEK_SHIFT) | S |
| S3 | **My demands' progress** | Where each of my demands stands, line by line | The execution report restricted to the user's own demands, with the per-line ledger inline (open, in RFQ, quoted, awarded, handed off, PO) and the next step per line — one page instead of one drawer per demand | existing execution + `demandReport` per demand | S |
| S4 | **Change-request effect on my demands** | What my changes cost | Per demand: requests raised, decided in how long, approved / partially / rejected, containers and quantity changed, and what happened downstream (re-awards, handoffs returned). Shows Sales the price of late changes | `ChangeRequest`, `ChangeRequestItem`, `Handoff` (ReturnCrId), `AwardItemChange` (CrId) | S |

### For management

| # | Report | The question it answers | Content | Source | Effort |
|---|---|---|---|---|---|
| M1 | **Monthly trend of the KPIs** | Are we getting better | The Performance headline per acceptance month, as lines: execution rate, not-sourced rate, on time, end to end and the stage times; per unit and per company. Today Performance shows one period only | the existing `performance()` run per month | S |
| M2 | **Cohort funnel** | How much of what was accepted in a month reached a PO, and how fast | For each acceptance month: accepted → in RFQ → quoted → awarded → handed off → PO created, as quantity and as containers, with the weeks it took; the cohorts still open show where they stopped | `QtySlice`, `SliceHistory` | M |
| M3 | **Committed and ordered value** | What we have committed to buy, per currency | Awarded value and value on SAP POs per month, currency, company, supplier and origin; committed but not yet ordered. Never converted between currencies (a rate table would be a separate decision) | `AwardItem` (Qty × UnitPrice, Currency), `PoDraftItem` | S |
| M4 | **Buyer workload and cycle times** | Where the work sits and who is overloaded | Per buyer: demands accepted, RFQs created, quotes recorded, awards, handoffs; open items and overdue; their stage times against the team's. Also per Sales user (demands, changes) and per PO-team member (handoffs, drafts). Fairness note: quantity mix differs by buyer; show medians and counts, not rankings | `Demand`, `Rfq`, `SupplierQuote`, `AwardBatch`, `Handoff`, `PoDraft` (CreatedBy / SentBy / SubmittedBy), `InboxItem` | M |
| M5 | **Exceptions and rework trend** | Is the process getting cleaner | Per month: handoffs returned (manual / automatic), SAP rejections and unknown outcomes, blocked change requests, escalated items, master-data requests; each with its top reasons | `Handoff`, `PoDraft`, `SapSubmission`, `ChangeRequest`, `InboxItem`, `MasterDataRequest` | S |
| M6 | **Supplier concentration and origin risk** | How dependent we are on a supplier, an origin, a port | Share of containers and value by supplier and by origin per month, the top-3 share, the number of active suppliers per origin, and origins with a single supplier | `AwardContainer` / `AwardShipment`, `ContainerGroup` → line `OriginCode`, `ShippingTerms` (ports) | S |

### Needs data the app does not hold yet (later)

| # | Report | What is missing |
|---|---|---|
| L1 | **Supplier delivery performance** (on-time arrival, quality) | Goods receipt and quality data; today the app ends at *PO created* |
| L2 | **Landed cost** | Freight, insurance and duty per container; the app holds only the purchase price and Incoterm |
| L3 | **Budget vs actual** | A budget per category / month; nothing in the app carries a budget |
| L4 | **Customer-level demand and fulfilment** | Demands have no customer field |

## 3 · Recommendation

If three are built first: **P1 Supplier scorecard** (Procurement decides suppliers every week and has nothing but the shortlist hint today), **S1 Arrivals schedule** (Sales' most-asked question, and every number already exists), and **M1 Monthly trend** (the cheapest one — the Performance query run per month — and the only way to see whether anything improves).

**Decision 2026-09-26:** the user chose the recommendation. P1, S1 and M1 are built as the Reports tabs **Suppliers**, **Arrivals** and **Trend** (spec 28). The rest stay here as backlog 39.

Two cross-cutting improvements would help every report: an **export on the dashboard cards**, and **saved filters** (backlog 13) so a manager's monthly view is one click.

Notes on rules: every candidate keeps spec 24's rules — company scope, never across units, N/A on a zero denominator, per-currency money — and, for P2 / P3 / M4, the database review's advice to page in SQL and to bound heavy queries to a period by default.
