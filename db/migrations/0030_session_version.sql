-- Security review 2026-09-26 (F07): sessions can be revoked. The session cookie carries the user's SessionVersion ("sv");
-- a cookie whose sv differs from the row is refused. It is raised on sign-out (which therefore signs the user out on every
-- device), when the user is disabled or archived, and when their roles or companies change. Cookies issued before this
-- migration carry no sv and count as 0, so they keep working until the first raise.
ALTER TABLE app.[User] ADD SessionVersion int NOT NULL CONSTRAINT DF_User_SessionVersion DEFAULT 0;
