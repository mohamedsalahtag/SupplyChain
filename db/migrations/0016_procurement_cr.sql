-- Demand-to-PO plan v5, Stage 4b: Procurement change requests decided by Sales (spec 19):
-- add quantity (+ extra containers), week shift, mix change.
ALTER TABLE scm.ChangeRequest DROP CONSTRAINT CK_ChangeRequest_Type;
ALTER TABLE scm.ChangeRequest ADD CONSTRAINT CK_ChangeRequest_Type CHECK (CrType IN
    ('CHANGE_CONTAINERS', 'CANCEL_WEEK', 'CANCEL_DEMAND', 'NOT_SOURCED', 'ADD_TO_DEMAND', 'WEEK_SHIFT', 'MIX_CHANGE'));
ALTER TABLE scm.ChangeRequestItem DROP CONSTRAINT CK_ChangeRequestItem_Kind;
ALTER TABLE scm.ChangeRequestItem ADD CONSTRAINT CK_ChangeRequestItem_Kind CHECK (ItemKind IN
    ('GROUP_COUNT', 'GROUP_ADD', 'GROUP_REMOVE', 'GROUP_COMPOSITION', 'QTY_NOT_SOURCED', 'WEEK_CONTAINERS',
     'ADD_QTY', 'ADD_CONTAINERS', 'WEEK_SHIFT', 'MIX_REDUCE', 'MIX_ADD'));
ALTER TABLE scm.ChangeRequest ADD RfqId bigint NULL CONSTRAINT FK_ChangeRequest_Rfq REFERENCES scm.Rfq (RfqId);  -- the RFQ it was raised from

-- RFQ line: a Procurement-proposed line (until Sales decides), and a pending / applied week shift.
ALTER TABLE scm.RfqLine ADD
    ProposedQty     bigint  NULL,    -- milli; Procurement-added line before Sales decides
    AddCrId         bigint  NULL CONSTRAINT FK_RfqLine_AddCr REFERENCES scm.ChangeRequest (CrId),
    WeekShiftCrId   bigint  NULL CONSTRAINT FK_RfqLine_ShiftCr REFERENCES scm.ChangeRequest (CrId),
    PreviousEtdWeek char(8) NULL;    -- the week before a (pending or applied) shift
GO

INSERT INTO scm.ReasonCode (ReasonCode, Context, Description, CountsAgainstProcurement)
SELECT 'MIX_OFFER', 'CR_PROC', 'Supplier offers another size or material mix', 0
WHERE NOT EXISTS (SELECT 1 FROM scm.ReasonCode WHERE ReasonCode = 'MIX_OFFER');
