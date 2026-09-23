# 08 · Suppliers (sync + Master data → Suppliers)

**Status:** Built 2026-09-24. Waiting for user acceptance.

## Source
SAP `API_BUSINESS_PARTNER` (OData v2), on the same gateway and login as Materials. Service path: Configuration → SAP connection.

| App field | SAP |
|---|---|
| Code, name, group | `A_Supplier`: Supplier, SupplierName, SupplierAccountGroup |
| Currency | `A_Supplier/to_SupplierPurchasingOrg`: PurchaseOrderCurrency of purchasing org **1000**, else the first org |
| Country, street, house no., postal code, city, region | `A_BusinessPartner/to_BusinessPartnerAddress` (first address) |
| Email | `…/to_BusinessPartnerAddress/to_EmailAddress` (first non-empty) |

## Before the first sync (Configuration → Suppliers sync)
1. **Load list from SAP**: every supplier group starting with **Z**, with how many suppliers each has. Other groups (e.g. KRED) are never offered.
2. Tick the groups to copy and **Save**. Nothing is ticked by default, and **Sync now** stays disabled until a group is saved.

## Sync
- Reads every supplier in the chosen groups, plus their addresses, and writes them in **one transaction**.
- New suppliers are inserted and changed ones updated. Suppliers no longer returned, or in groups you untick, are marked **Not in SAP**, never deleted.
- **Pressing Sync again never duplicates.** Suppliers are keyed by their SAP code. Verified: a second run gave 484 read, 0 new, 0 updated.

## Screen: Master data → Suppliers
- **Columns:** Code, Name, Group, Country, Currency, City, Address (hidden by default), Email, Status.
- **Tools:** search (code, name or email), and multi-select Group, Country and Currency filters.
- **Details panel:** supplier details and the full address.

## Loose-end check
| Question | Answer |
|---|---|
| Supplier with no address or email in SAP | The fields stay blank; the sync result counts the suppliers with no address. |
| Supplier with no purchasing org 1000 | The first org's currency is used; if there is no org at all, the currency is blank. |
| SAP fails part-way | The DB is unchanged: all pages are read before the single write. |
| Two users press Sync | Only one sync runs; the other sees who started it. |

Permissions: `suppliers.open`, `configuration.suppliers.edit`, `configuration.suppliers.run`.
