# 06 · Users (Administration → Users)

**Status:** Built 2026-09-24. Waiting for user acceptance.

## Purpose
Register the people who may sign in, and choose their roles.

## Main path
1. **Add user** opens a drawer where you type at least 2 letters of a name, username or email. It searches Active Directory with the search account and shows at most 25 people; people already registered are marked.
2. Pick a person, choose roles (**Administrator** is pre-selected until other rules exist), then **Register**. The server reads the person from AD again; it never trusts details sent by the browser.
3. Clicking a user opens their details (from AD), roles, and the Active / Disabled switch. **Save**.

## Table
Name, Username, Email, Department (hidden by default), Roles, Status, Last sign-in. Search, plus multi-select filters for Role and Status.

## Loose-end check
| Question | Answer |
|---|---|
| No search account saved | "Add it in Configuration → Active Directory". |
| Search account password wrong or changed | A clear message pointing to the Active Directory tab. |
| Registering someone twice | Refused: "already registered". |
| Disabling yourself / removing your own admin role | Refused. |
| Removing the last active administrator | Refused. |
| Deleting a user | Not offered: disable instead, so the audit history keeps its meaning. |

Permissions: `users.open`, `users.add`, `users.edit`.
