# Global invariants (plan v5 §6)

One `.sql` file per invariant. Each query must return **zero rows** on valid data. The first line is a comment naming the invariant, e.g. `-- 1. Line ledger`.

`npm run test:db` runs them all against the throw-away test database after the service tests. The invariants that apply at each stage are listed in plan §6.1. Stage 0 has none; they begin with Stage 1 (invariants 1, 2, 3, 15, 18).
