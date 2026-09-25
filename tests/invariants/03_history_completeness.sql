-- 3. History completeness: each slice's state = ToState of its latest history row (and every slice has history).
SELECT s.SliceId, s.ExecState, h.ToState
FROM scm.QtySlice s
OUTER APPLY (SELECT TOP 1 ToState FROM scm.SliceHistory x WHERE x.SliceId = s.SliceId ORDER BY x.HistoryId DESC) h
WHERE h.ToState IS NULL OR h.ToState <> s.ExecState;
