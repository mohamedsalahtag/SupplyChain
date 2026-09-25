# Backup and restore

## What to back up (together, at the same point in time)
1. **The SQL Server database** (`DB_NAME` in `.env`): take a full backup nightly and log backups every 15 minutes. It holds the ledger, the history, the SAP outbox and the audit log.
2. **The attachments folder** (`ATTACHMENTS_DIR`, default `<repo>/data/attachments`). Files are stored by their SHA-256 hash and are never changed or deleted, so a copy in the same nightly window is enough.
3. **`.env`**: keep it in the IT vault, not with the backups. It holds `SESSION_SECRET` and `SETTINGS_ENCRYPTION_KEY`. Without the encryption key, the saved SAP and AD passwords can't be read after a restore; they must then be entered again in Configuration.

## Restore drill (do once before go-live, then twice a year)
1. Restore last night's database backup to a **test** server, with a new database name.
2. Copy the attachments folder next to it and point a test `.env` at both. Set `NODE_ENV=production`, `ALLOW_SAP_STUB=true` and the test SAP.
3. Start the API. Check that the health check says *connected* and that you can sign in.
4. Run every `tests/invariants/*.sql` query. **Each must return 0 rows.**
5. Open three demands, one award and one PO draft, and download one attachment. The checksum is verified on download.
6. **Outbox after a restore:** drafts that were *Sent to SAP* or *SAP outcome unknown* at backup time must **not** be sent again blindly.
   - The restored claims have old leases, so they become *unknown* and SAP is asked by reference first.
   - On the test server, point SAP at the test system, or inject `lookup-unknown` faults, and confirm that the drafts end *found* or in *Needs a person*, never as a second create.
7. Record the date, the backup used, the time taken and the result in the IT change log.

## Recovery point and time (proposal)
- **Recovery point:** up to 15 minutes (the log backups).
- **Recovery time:** under 4 hours.

After a restore to an earlier point, **reconcile with SAP**: POs created in SAP after the restore point appear as *SAP outcome unknown* and are found by reference.
