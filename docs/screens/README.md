# Screen specs

One file per approved screen: `NN-name.md`. A screen is built only after its spec is here.

Each spec contains:

- **Purpose** — one sentence.
- **Users** — who opens it.
- **Main path** — numbered steps, the simple straightforward case only.
- **Process flow** — Mermaid diagram.
- **Loose-end check** — way in / way out, owner, what happens on failure, what happens if two users act at once.
- **Fields and buttons** — exactly what appears.
- **Out of scope** — what is deliberately not included (moved to the backlog).
- **Mockup** — link to the approved clickable mockup.

| # | Screen | Status |
|---|--------|--------|
| 00 | App shell (layout + Home with health) | Built |
| 01 | Materials (read-only list) | Built · waiting for acceptance |
| 02 | Configuration · SAP connection (test + sync) | Built · waiting for acceptance |
| 03 | Configuration · Appearance (app font size) | Built · waiting for acceptance |
| 04 | Configuration tabs, site name, icon; table columns + rows per page; multi-select filters | Built · waiting for acceptance |
| 05 | Sign-in with Active Directory; Configuration → Active Directory | Built · waiting for acceptance |
| 06 | Users (register from AD, roles, active) | Built · waiting for acceptance |
| 07 | Security (roles and permissions) | Built · waiting for acceptance |
| 08 | Suppliers: Z-group choice, sync, Master data → Suppliers | Built · waiting for acceptance |
| 09 | Purchase orders: Z-type + start-date choice, incremental sync, Purchasing → Purchase orders | Built · waiting for acceptance |
