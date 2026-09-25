-- Database review 2026-09-25: indexes found by measuring 20,000 demands (~3.8 million workflow rows) in supplychain_perf.
-- Covering indexes carry the columns the hot queries read, so SQL Server answers from the index without row lookups;
-- the others index foreign keys the application looks rows up by (filtered where the column is mostly empty).

-- Ledger: every status, list and report sums slices per line / RFQ line / award item / handoff by state.
DROP INDEX IX_QtySlice_LineState ON scm.QtySlice;
CREATE INDEX IX_QtySlice_LineState ON scm.QtySlice (LineId, ExecState) INCLUDE (Qty, BusinessOrigin, CancelOrigin, ArrivedVia);
DROP INDEX IX_QtySlice_RfqLine ON scm.QtySlice;
CREATE INDEX IX_QtySlice_RfqLine ON scm.QtySlice (RfqLineId) INCLUDE (ExecState, Qty) WHERE RfqLineId IS NOT NULL;
DROP INDEX IX_QtySlice_AwardItem ON scm.QtySlice;
CREATE INDEX IX_QtySlice_AwardItem ON scm.QtySlice (AwardItemId) INCLUDE (ExecState, Qty) WHERE AwardItemId IS NOT NULL;
-- Handoff accept/return, PO submit and SAP outcomes move slices by handoff: was a scan of the whole ledger.
CREATE INDEX IX_QtySlice_Handoff ON scm.QtySlice (HandoffId) INCLUDE (ExecState, Qty) WHERE HandoffId IS NOT NULL;
-- Reports: slices by state (e.g. every PO-created slice), with what the KPIs read.
CREATE INDEX IX_QtySlice_State ON scm.QtySlice (ExecState) INCLUDE (LineId, Qty, AwardItemId, EffectiveSubmittedAt, SplitFromSliceId);
CREATE INDEX IX_QtySlice_SplitFrom ON scm.QtySlice (SplitFromSliceId) WHERE SplitFromSliceId IS NOT NULL;

-- Ledger history: read per slice with its trigger and time (stage times, demand history).
DROP INDEX IX_SliceHistory_Slice ON scm.SliceHistory;
CREATE INDEX IX_SliceHistory_Slice ON scm.SliceHistory (SliceId, HistoryId) INCLUDE (TriggerName, ChangedAt, Action);

-- Demand lines by demand with the requested quantity (status view, lists).
DROP INDEX IX_DemandLine_Demand ON scm.DemandLine;
CREATE INDEX IX_DemandLine_Demand ON scm.DemandLine (DemandId) INCLUDE (DemandWeekId, RequestedQty, Unit, IsActive);

-- Demands: lists and reports filter by company and order/filter by date.
CREATE INDEX IX_Demand_CompanyCreated ON scm.Demand (CompanyCode, DemandId DESC) INCLUDE (WorkflowStatus, CreatedBy, AcceptedAt);
CREATE INDEX IX_Demand_Accepted ON scm.Demand (AcceptedAt) INCLUDE (CompanyCode) WHERE AcceptedAt IS NOT NULL;

-- Quotes by RFQ: the only index was filtered on IsCurrent = 1, which a parameterised query cannot use.
CREATE INDEX IX_SupplierQuote_Rfq ON scm.SupplierQuote (RfqId, SupplierCode) INCLUDE (IsCurrent, EtdWeek, LineKey);

-- Foreign keys the application looks up by.
CREATE INDEX IX_RfqLine_DemandLine ON scm.RfqLine (DemandLineId) WHERE DemandLineId IS NOT NULL;
CREATE INDEX IX_AwardItem_RfqLine ON scm.AwardItem (RfqLineId);
CREATE INDEX IX_AwardItemSku_Item ON scm.AwardItemSku (AwardItemId) INCLUDE (IsActive);
CREATE INDEX IX_PoDraftItem_AwardItem ON scm.PoDraftItem (AwardItemId);
CREATE INDEX IX_PoDraftItem_Demand ON scm.PoDraftItem (DemandId, DemandLineId);
CREATE INDEX IX_SalesAck_Demand ON scm.SalesAck (DemandId);
CREATE INDEX IX_SalesAckHistory_Ack ON scm.SalesAckHistory (AckId);
CREATE INDEX IX_SapSubmissionAttempt_Submission ON scm.SapSubmissionAttempt (SubmissionId);
CREATE INDEX IX_ChangeRequest_Rfq ON scm.ChangeRequest (RfqId) WHERE RfqId IS NOT NULL;
CREATE INDEX IX_ChangeRequest_Company ON scm.ChangeRequest (CompanyCode, CrId DESC);
CREATE INDEX IX_ChangeRequestItem_Line ON scm.ChangeRequestItem (LineId) WHERE LineId IS NOT NULL;
CREATE INDEX IX_ContainerGroup_Demand ON scm.ContainerGroup (DemandId);
CREATE INDEX IX_MergeItem_SourceLine ON scm.MergeItem (SourceLineId);
CREATE INDEX IX_MergeItem_TargetLine ON scm.MergeItem (TargetLineId);
CREATE INDEX IX_MasterDataRequest_Item ON scm.MasterDataRequest (AwardItemId);
CREATE INDEX IX_Rfq_Company ON scm.Rfq (CompanyCode, RfqId DESC) INCLUDE (DemandId, ManualStatus);
CREATE INDEX IX_UserRole_Role ON app.UserRole (RoleId);
