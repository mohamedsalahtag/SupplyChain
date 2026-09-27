# Report metric dictionary

What each KPI on Reports means, taken from the code (`apps/api/src/modules/reports/`: `reports.ts`, `pure.ts`, `dashboard.ts`, `insights.ts`, `counts.ts`). Specs: 24 (Performance, execution, register), 26 (Dashboard), 28 (Arrivals, Suppliers, Trend).

**Rules for every metric**
- **Company scope.** Only the user's companies (`scm.UserCompany`), narrowed by the Company filter. Needs `reports.open`.
- **Units.** Quantities are BIGINT milli-units, summed exactly and shown per unit. They are never added across units. Containers are the only measure without a unit; they are the only thing summed across demands.
- **Money** is per currency and never converted.
- **N/A.** A rate with a zero denominator is N/A (null), never 0%. Rates are percent with one decimal.
- **n** next to a rate or time is the number of demands it measures.
- **Refresh.** *Live* means the current state: refreshed every 60 s on the Dashboard, and the dates are ignored. *Period* means it follows From – To; To is inclusive and dates are UTC.
- **Search (`q`).** Execution and Performance (all sections): demand number. Register: CR or demand number. Arrivals: demand, supplier, material, SKU or SAP PO. Suppliers: supplier code or name. The Dashboard and Trend have no search.

## Slice states used below
- **Committed:** slices with business origin SALES or CHANGE, except merged-out ones and those cancelled by SALES or CHANGE.
- **Executed:** slices with origin SALES or CHANGE in state PO_CREATED.
- **Not sourced:** slices with origin SALES or CHANGE, cancelled with origin PROCUREMENT.
- **Outstanding:** slices in OPEN, IN_RFQ, QUOTED, AWARDED, HANDED_OFF, PO_PREPARATION or PO_SUBMITTED.
- **Procurement added:** slices with origin PROCUREMENT, not merged out or cancelled. **Procurement ordered:** the same slices in PO_CREATED. Both are shown apart and stay out of every rate.

## Performance (spec 24) · Dashboard D8 · Trend (per month)
Grain: per unit. Cohort: demands with `WorkflowStatus = ACCEPTED` whose `Demand.AcceptedAt` falls in the period. The default is the last 3 months on Performance and the last 12 weeks on the Dashboard. Source: `scm.Demand`, `DemandLine`, `QtySlice`. Refresh: period.

| KPI | Meaning | Numerator / denominator | Unit | Exclusions |
|---|---|---|---|---|
| Committed | What Sales asked for and did not cancel | Σ committed | qty per unit | merged-out (counted on the demand it merged into), Sales/change cancellations, Procurement additions |
| Executed | Ordered in SAP | Σ executed | qty per unit | Procurement additions |
| Outstanding | Still in progress | Σ outstanding | qty per unit | — |
| Execution rate | Share of the commitment with a SAP PO | executed ÷ committed; n = demands with committed > 0 | % | N/A when committed = 0 |
| Not-sourced rate | Share Procurement could not source | not sourced ÷ committed | % | as above |
| On time | PO created at least `kpiOnTimeDaysBeforeEtd` days (setting, default 7) before the confirmed ETD | qty of PO-created slices with (ConfirmedEtd − PO created) ≥ setting ÷ qty of PO-created slices that have a confirmed ETD; n = demands | % (quantity-weighted) | slices without a confirmed ETD |
| Accepted → PO created (end to end) | Time from the demand's effective submit (`EffectiveSubmittedAt`) to SAP_CONFIRMED | Σ(qty × hours) ÷ Σ qty over PO-created slices; n = demands | hours (days when ≥ 48 h) | quantity not yet PO-created |
| Stage times | Accept → RFQ (from the later of accepted and the clock start), RFQ → quote, quote → award, award → handoff, handoff accepted → PO created | the same weighting, from the first `SliceHistory` event of each trigger; a split slice uses its ancestors' events up to the split | hours | stages with a missing event |

Performance only (the same cohort filter on the event's own date, and the same search):

| KPI | Meaning | Source · date | Numerator / denominator |
|---|---|---|---|
| CR response | Average hours from submitted to decided, per deciding department | `ChangeRequest` · SubmittedAt | decided CRs |
| Sales acknowledgement | Batches; average hours from batch to acknowledgement (real acknowledgements only); resets (Σ Revision − 1); handed off without it | `AwardBatch` × `SalesAck` · batch CreatedAt | — |
| Handoff return rate | Returned **by the PO team** (`Status = RETURNED` and `ReturnedBy` set) ÷ handoffs sent. Automatic returns (`ReturnedBy` null) and SKU issues are counted apart | `Handoff` · SentAt | returned by PO team / handoffs |
| SAP first-reply rate | Drafts created on SAP's first reply ÷ drafts submitted (SUBMITTED, UNKNOWN, CREATED, REJECTED); also counted: after a lookup, resolved by hand, rejected, unknown now | `PoDraft` · SubmittedAt | SAP_REPLY / submitted |

**Trend (spec 28).** The rows above per **month of acceptance**: the demands accepted in that month, however far they have come since, so recent months read lower. Handoffs and SAP are bucketed by their own month. Months: the last 12 when no dates are picked. With dates, the first and last month are cut to From / To. The trend keeps at most the latest 24 months. It is fetched once for the whole range and bucketed in code with the same `headlineOf`.

## Demand execution (spec 24)
Grain: accepted demand × unit. Cohort: AcceptedAt in the period. Refresh: period. Committed, executed, not sourced, cancelled by Sales, outstanding, Procurement added and ordered are as defined above. The execution rate is per row.

## Dashboard (spec 26)
| Card | KPI | Grain · unit | Source | Cohort / date | Refresh |
|---|---|---|---|---|---|
| D1 Where the quantity is | Quantity by class: on PO (PO_SUBMITTED + PO_CREATED), awarded (AWARDED, HANDED_OFF, PO_PREPARATION), in RFQ (IN_RFQ, QUOTED), open, cancelled | unit · qty | `QtySlice` of active lines | accepted demands with any outstanding slice; merged-out slices excluded | live |
| D2 Who has the ball | Open work items, overdue (DueAt < now), oldest | step × owning roles · count | `InboxItem` (IsOpen = 1) × role permissions | open now | live |
| D3 Shipping soon | Containers per ETD week, for the next 10 weeks: ordered, awarded, in RFQ, open, and the baseline | week · containers | `DemandWeek`, `AwardShipment` (active), `PoDraft` CREATED, the baseline snapshot | Ordered and awarded are real. The not-yet-awarded containers are split between open and in RFQ by quantity shares — an estimate | live |
| D4 Not yet sourced, shipping soon | Open quantity with ETD week ≤ now + `agingWeeksBeforeEtd` | line · qty per unit | OPEN slices | now | live |
| D5 RFQs out | Sent RFQs where an invited supplier has no current quote and quantity is still to quote; days out; overdue = the Record quotes item is past due | RFQ · count | `Rfq`, `RfqSupplier`, `SupplierQuote` (IsCurrent = 1), `InboxItem` | now | live |
| D8 Headline | As Performance | | | | period (default: last 12 weeks) |
| D10 Flow | **Accepted** = containers as accepted, from the baseline snapshot (`DemandVersion` at `BaselineVersion`, set on the first acceptance), in the AcceptedAt ISO week. A demand without a baseline counts its current `DemandWeek` containers. **Ordered** = active shipments behind a CREATED draft, in the week of `COALESCE(SapCreatedAt, SubmittedAt, CreatedAt)`. **Backlog** = the current containers of in-progress demands minus their ordered shipments | ISO week · containers | as stated | period; backlog live | period |
| D11 Change requests | Waiting (SUBMITTED) and blocked are live. Decided and average response, and reasons (withdrawn excluded), by SubmittedAt | department / reason · count | `ChangeRequest`, `ReasonCode` | as stated | now + period |
| D12 Stability | Changed after acceptance = a version after the baseline whose reason is not SUBMIT, RESUBMIT or ACCEPT (changed ÷ accepted). Merges = MERGE_IN versions. Per unit: committed, cancelled by Sales or a change, with the rate cancelled ÷ (committed + cancelled), not sourced, Procurement added, merged in | demand / unit | `Demand`, `DemandVersion`, slices | AcceptedAt in the period | period |
| D14 Top suppliers | Containers awarded (active shipments of batches created in the period), share of the total, and handoffs **returned by the PO team** (`ReturnedBy` set, handoffs sent in the period) | supplier · containers | `AwardShipment`, `AwardBatch`, `Handoff` | batch CreatedAt; handoff SentAt | period |

## Arrivals (spec 28)
Grain: award item (awarded material) with its shipment. Source: `AwardItem` (active, qty > 0), `AwardBatch`, `RfqLine`, `AwardShipment`, `Handoff` (HANDED_OFF / ACCEPTED), `PoDraft` (live states). Cohort: ETD week from the From week (default: the current week) to the To week. Refresh: on load.
- **Status:** the furthest ledger state of the item's slices: PO created › sent to SAP › PO being prepared › handed off › awarded.
- **Quantity:** per unit. **Value:** qty × unit price, per currency.
- **Containers:** per shipment (supplier × week). They repeat on each material of the shipment; the total counts each shipment once.

## Suppliers scorecard (spec 28)
Grain: supplier. Period: the last 12 months when no dates are picked. Refresh: on load.

| KPI | Meaning | Source · date | Numerator / denominator |
|---|---|---|---|
| Invited · Quoted · Quote rate | Invitations on RFQs sent; quoted = at least one current quote | `RfqSupplier`, `SupplierQuote` (IsCurrent = 1) · Rfq SentAt | quoted ÷ invited |
| Quotes | Current quote rows | as above | — |
| First contact | Invitations outside the shortlist | `RfqSupplier.OutsideShortlist` | — |
| First quote after | Average hours from RFQ sent to the **first quote recorded in the app**, over all quote rows (current and replaced), so a revision does not move it. This is when Procurement recorded the quote, not when the supplier sent it | `SupplierQuote.RecordedAt` · SentAt | RFQs with a quote |
| Cheapest | Rows (RFQ × week × line key × currency) with at least 2 current quotes where this supplier ranks first on unit price | `SupplierQuote` (current) · SentAt | cheapest ÷ compared |
| Containers · Awards · Value | Active shipments; award batches; Σ qty × price per currency | `AwardShipment`, `AwardItem` · batch CreatedAt | — |
| Above offer · Un-awarded · SKU corrections | Counts from the award change logs | `AwardContainerChange`, `AwardItemChange` · ChangedAt | — |
| Handoffs · Returned · Return rate · SKU issues · POs created | Handoffs sent. Returned = by the PO team (`ReturnedBy` set). POs created = handoffs with a CREATED draft | `Handoff`, `PoDraft` · SentAt | returned ÷ handoffs |

## Tab counts
`reports.counts`: COUNT queries only, with the same filter, scope and rows as Demand execution (demand × unit), the register, Arrivals and the scorecard.
