# 21 · Status wording: who has it, what is next (cross-cutting)

**Status:** Approved 2026-09-24 as a hybrid of the two mockups — built, ACCEPTED 2026-09-25. From the first mockup (`docs/mockups/status-wording.html`): 1 Demands list, 3 RFQs list, 5 Awards, and the labels everywhere. From the second: 2 Demand page header and 4 RFQ page header (process steps + status block). Asked by the user before accepting Stage 5: *"I don't know who it was submitted to… Draft by Sales or by Procurement, or by who? … The status needs to be more clear and descriptive."*

## Purpose
Every status in the app says, in plain words, **who has the record now** and **what happens next**, and the page shows **who did the last step and when**. Wording and display only: the statuses and the rules behind them do not change.

## Users
Everyone who reads a status: Sales, Procurement, the PO team later.

## Main path
1. **Status tag** — the new label (tables below). Hovering it shows a one-line explanation: what it means and who acts next. On the demand list, a draft also shows a *Sales* chip.
2. **"Last step" column** on the Demands and RFQs lists: who did the last step, their role, when, and the reason/comment when there is one (e.g. *Returned by Omar (Procurement) · 24 Sep 11:30 · "Wrong week"*).
3. **Page header** of a demand and an RFQ (from the second mockup): the **process steps** with the current one highlighted (Demand: Sales prepares → Procurement review → Accepted → Sourcing (RFQ) → Awarded → Ordered (PO) → Closed; RFQ: Prepared → Sent to suppliers → Quotes in → Awarded → Handed off → Closed), then a **status block**: *Now* (what the quantity is doing, with the awards and their acknowledgement), *Who has it*, *Next* (a link when the viewer can do it), *History* (every step: who, role, when, reason). The RFQ block starts with **Sent to**: each invited supplier with *✓ quoted (date)* or *no quote yet*, and **Sent**: by whom, when — *the supplier view was downloaded and e-mailed outside the app*.
4. **Progress bar** on the Demands list: how much of the quantity is open, in RFQ, awarded, on PO, cancelled.
5. **"What do the statuses mean?"** on the Demands, RFQs and Awards lists opens a drawer with every status, who has it and what is next.

## Demand statuses
| Code (unchanged) | Old label | New label | Who has it | Next |
|---|---|---|---|---|
| DRAFT | Draft | **Draft** + chip *Sales* | Sales | Sales submits it to Procurement |
| SUBMITTED | Submitted | **Waiting for Procurement to accept** | Procurement | Accept, or return to Sales (Sales can still take it back) |
| RETURNED | Returned | **Returned to Sales** | Sales | Change and submit again |
| NOT_STARTED | Not started | **Accepted · nothing sourced yet** | Procurement | Create an RFQ |
| PARTIALLY_IN_EXECUTION | Partially in execution | **Partly in sourcing** | Procurement | Source the open part |
| FULLY_IN_EXECUTION | Fully in execution | **All in sourcing** | Procurement | Quote, award, hand off |
| CLOSED_FULLY_EXECUTED | Closed · fully executed | **Closed · all ordered** | — | Nothing |
| CLOSED_PARTIALLY_EXECUTED | Closed · partially executed | **Closed · partly ordered, rest cancelled** | — | Nothing |
| CANCELLED | Cancelled | **Cancelled** (+ by whom, reason) | — | Nothing |
| MERGED | Merged | **Merged into D-…** (the target's number, linked) | — | Continue on the other demand |

## RFQ statuses
| Code (unchanged) | Old label | New label | Meaning · next |
|---|---|---|---|
| DRAFT | Draft | **Draft · not sent to suppliers** | Procurement prepares it. Next: download the supplier view, send it outside the app, press Send. |
| SENT | Sent | **Sent · waiting for quotes** | Marked sent to the invited suppliers (the app does not e-mail; the supplier view goes out by e-mail). |
| QUOTING | Quoting | **Quotes in · ready to award** | At least one quote recorded. Next: record the rest, or Award…. |
| PARTIALLY_AWARDED | Partially awarded | **Partly awarded** | Next: award the rest, or release it. |
| FULLY_AWARDED | Fully awarded | **Fully awarded** | Next: handoff (Stage 6). |
| CLOSED | Closed | **Closed · nothing left (all released)** | The RFQ holds no quantity: everything was released or un-awarded back to the demand, where it is open again. |
| CANCELLED | Cancelled | **Cancelled** (+ by whom, reason) | Its quantity went back to the demand. |

The RFQ list's **Suppliers** column shows *n of m quoted* (or *m invited* before sending).

## Award (Sales acknowledgement) statuses
| Old | New |
|---|---|
| Sales: pending | **Waiting for Sales to acknowledge** |
| Sales: query | **Sales asked a question** |
| Sales: acknowledged / acknowledged late | **Acknowledged by Sales** / **Acknowledged by Sales after handoff** |

## Loose-end check
| Case | Outcome |
|---|---|
| A step done through View as | The last step shows the demo user's name (as recorded). |
| Old records with no recorded actor for a step | The last step shows the date only. |
| A Merged demand | The label names and links the target demand. |
| The viewer cannot do the next step | *Next* is text, not a link. |

## Out of scope
- New statuses or changed rules (only wording and display).
- My work tabs keep their verbs (they already say the action).
