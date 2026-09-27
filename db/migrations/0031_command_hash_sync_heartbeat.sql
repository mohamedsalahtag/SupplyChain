-- Review fixes 2026-09-26.
-- 1. A command id reused for a different command or a different input is refused (COMMAND_KEY_REUSED) instead of
--    replaying the first command's result: runCommand stores a SHA-256 of the canonical JSON input. NULL for older rows
--    (and for commands that pass no input), which are then compared by user and command name only.
IF COL_LENGTH('scm.CommandLog', 'InputHash') IS NULL
    ALTER TABLE scm.CommandLog ADD InputHash char(64) NULL;
GO
-- 2. A running sync records a heartbeat while it works; a run is judged abandoned by its last heartbeat (or its start,
--    when it never beat), not by its start alone, so a long sync that is still working is not marked failed.
IF COL_LENGTH('integ.SyncRun', 'HeartbeatAt') IS NULL
    ALTER TABLE integ.SyncRun ADD HeartbeatAt datetime2(0) NULL;
GO
