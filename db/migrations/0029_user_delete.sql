-- Users page → Delete (2026-09-26). A user who never did anything is deleted outright; one whose name is on records
-- (demands, RFQs, awards …) is archived instead: hidden from the Users list, unable to sign in, roles and companies removed,
-- username freed (so the person can be registered again), display name kept so history still says who did what.
ALTER TABLE app.[User] ADD DeletedAt datetime2(0) NULL;
