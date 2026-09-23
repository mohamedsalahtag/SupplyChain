# 03 · Appearance (Configuration section)

**Status:** Built 2026-09-23. Waiting for user acceptance. No mockup: the user specified it directly.

## Purpose
Control the font size of the whole app, for every user.

## Users
An administrator. Permission to change it: `settings.ui.edit`. Every screen reads it with `app.view`.

## Main path
1. The user opens **Settings → Configuration → Appearance**.
2. They pick a size from 10–16 px. The preview line shows it.
3. **Save**. The whole app re-renders at that size straight away. Other users get it the next time they load the app.

## Loose-end check
| Question | Answer |
|---|---|
| Default | 13px (changed from 11 on 2026-09-23 at the user's request). |
| Is the number real? | Yes. The chosen number is the on-screen size; compact mode no longer shrinks it. |
| Setting can't be loaded | The app uses the 13px default. |
| Two admins save different sizes | The last save wins. It is one setting for everybody. |

## Out of scope (backlog)
- A different font size for each user
- Dark mode
