# 04 · General settings and table behaviour

**Status:** Built 2026-09-23. Waiting for user acceptance. No mockup: the user specified it directly.

## Configuration page
One page, **Settings → Configuration**, with tabs:

| Tab | Holds |
|---|---|
| General | Site name (header and browser tab) and the app icon (upload PNG/JPG/SVG/WEBP/ICO up to 256 KB, or use the built-in icon) |
| Appearance | Font size 10–16px, **default 13** ([03](03-appearance.md)) |
| SAP connection | Connection form and Test ([02](02-sap-connection.md)) |
| Materials sync | Last result and Sync now ([02](02-sap-connection.md)) |

Site name, icon and font size are app-wide: one value for every user, stored in `app.Setting`.

## Every table
- **Rows per page** 25 / 50 / 100 (default 25).
- **Columns** button: show or hide any column; at least one must stay visible. "Show all columns" resets.
- Both are saved **per user in the database** (`app.UserPreference`). They survive restarts, browser changes and cleared caches, and change only when the user changes them.

## Every filter
Multi-select: a row matches when its value is any of the chosen ones. Sub-major options narrow to the chosen Major categories; a chosen sub-major that no longer fits is dropped.

## Loose-end check
| Question | Answer |
|---|---|
| Preferences can't be loaded | The table waits for them (no flash of the wrong page size); on error it uses the defaults. |
| Saving a preference fails | The change is undone on screen. |
| Invalid icon upload | Rejected in the browser, and again on the server (type and size). |
| Two admins change the site name | The last save wins. |

## Out of scope (backlog)
- Reordering or resizing columns
- Saved filter sets
