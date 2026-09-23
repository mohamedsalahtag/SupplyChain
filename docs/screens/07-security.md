# 07 · Security (Administration → Security)

**Status:** Built 2026-09-24. Waiting for user acceptance. The design follows the screenshot of the user's other app.

## Purpose
Build roles from the screens and buttons each one may use. Roles are then assigned on the Users page.

## Layout
- **Left:** the roles, each with its user and permission counts and a Built-in tag. **New role** is at the top right.
- **Right:** role name, description, Active, **Save details**, and **Delete**. Delete works only when nobody holds the role.
- **Permissions tab:**
  - search, Expand all / Collapse all, and "X of Y permissions granted";
  - screens grouped by section (General, Master data, Administration), one card per screen, each with a **Can open this screen** switch, a switch for each button, and Select all / None;
  - switching a screen off also switches off its buttons;
  - changes take effect only after **Save permissions** (there is also Discard).
- **Users tab:** who holds the role. Roles are assigned on the Users page.
- **Administrator** is built in: it always has every permission, including screens added later, and is shown locked.

## The catalogue
The list is `packages/shared/src/permissions.ts`, a single list in code. A unit test fails if any API function uses a permission that isn't in the list, so every new screen and button appears here automatically.

## Loose-end check
| Question | Answer |
|---|---|
| Two roles with the same name | Refused. |
| A permission key that isn't in the catalogue | Refused by the server. |
| A button without its screen | Not possible: the buttons are off and locked until the screen may be opened. |
| Deleting a role that users hold | Refused: remove it from those users first. |
| Changes take effect | On the holders' next click. Every change is audited. |

Permissions: `security.open`, `security.roles.edit`.
