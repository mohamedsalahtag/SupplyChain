# UAT script

Run this on the test server with real users, one per role, in company 1000. Each step has an expected result. Tick it, or write the defect number. Sales, Procurement and the PO team sign at the end.

## A. Sales
| # | Do | Expected |
|---|---|---|
| A1 | Sign in. Open **My work**. | Only your tasks. The side menu shows Demands, Change requests, Reports. |
| A2 | **Demands → New demand**, company 1000. Add week +3 with a container group of 2 × 1,540 CT. Add materials: Apples · Royal Gala · 2 sizes × 2 classes, shares 40/30/20/10. | Share total 100% in green. Quantities per item are shown. |
| A3 | Copy the group to week +4. Save. | Draft saved. Two weeks, four lines each. |
| A4 | Submit. | Version 1 (baseline). Status *Submitted — waiting for Procurement*. |
| A5 | Try to accept your own demand (if you also hold Procurement rights). | No Accept button. The server refuses. |

## B. Procurement
| # | Do | Expected |
|---|---|---|
| B1 | My work → **Accept** the demand. | Status *Accepted*. Quantity *Open* in the ledger. |
| B2 | **Create RFQ** for week +3 with two suppliers. Send it. | RFQ-… *Sent*. Supplier view CSV downloads. |
| B3 | Record quotes for both suppliers (price, containers offered). | Quotes saved. The lowest price is marked. |
| B4 | **Award…**: 1 container to each supplier. | Award AB-… created. Sales gets *Acknowledge*. |
| B5 | Handoff tab: complete the terms (FOB, Valparaíso → Jeddah, payment terms) and the confirmed ETD. | Checklist green except "Sales acknowledged". |
| B6 | Hand off supplier 1 **without** acknowledgement (reason URGENT). | HO-… *Waiting for the PO team to accept*, marked *without Sales acknowledgement*. |

## C. Sales (acknowledgement and change)
| # | Do | Expected |
|---|---|---|
| C1 | My work → **Acknowledge** the award. | The handoff shows *Sales acknowledged it later*. |
| C2 | Raise a change request: cancel 1 container in week +4. | CR-… *Submitted*; Procurement gets *Decide*. |

## D. Procurement (decide)
| # | Do | Expected |
|---|---|---|
| D1 | Open the CR and choose **Decide** (approve). | A confirmation summarises the decision; the change applies at once; the demand's week +4 has 1 container less. |

## E. PO team
| # | Do | Expected |
|---|---|---|
| E1 | My work → **Accept handoff**. | *Accepted — PO being prepared*. The PO preparation card appears. |
| E2 | **Pick SKU…** for each item (split one item across 2 SKUs). | The quantities must add up; the SKUs are saved. |
| E3 | **Build PO draft** → **Validate** → **Submit to SAP** (confirm). | POD-… *Sent to SAP*, then *Created in SAP* with a PO number, within a minute. |
| E4 | In SAP, open the PO by its number. | One PO, with the reference POD-…, the supplier, plant, terms and items as shown. |
| E5 | Return a second handoff (reason TERMS). | Procurement gets *Handoff returned*; the quantity is back to *Awarded*. |

## F. Reports (any role)
| # | Do | Expected |
|---|---|---|
| F1 | **Reports → Demand execution**, search the demand. | Committed, executed, outstanding per unit; execution % (N/A when nothing is committed). |
| F2 | Click the row. | Containers per week: baseline, now, awarded, ordered. Lines with the SAP PO number. CSV downloads. |
| F3 | **Change request register**. | The CR from C2 with its decision time. |
| F4 | **Performance**. | Stage times per unit; SAP created on the first reply. |

## G. Administrator
| # | Do | Expected |
|---|---|---|
| G1 | **Administration → Operations status**. | All green; no test-switch banner on the UAT server except the stub notice. |
| G2 | Give a Procurement user the Sales role too. | Listed under separation of duties. Remove it again. |
| G3 | Sign in as a user of company 2000 and open the demand's link from A2. | *Demand not found*. |

## Sign-off
| Role | Name | Date | Result (accepted / accepted with defects / not accepted) |
|---|---|---|---|
| Sales | | | |
| Procurement | | | |
| PO team | | | |
| IT | | | |
