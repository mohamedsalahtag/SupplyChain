-- Delete a draft demand (2026-09-29): a draft or returned demand that was never accepted is marked deleted instead of
-- removed — its versions and comments are immutable history (TR_DemandVersion_Immutable, TR_ThreadEntry_Immutable).
-- A deleted demand is hidden everywhere (lists, filters, the page, its comments and attachments) and can no longer change.
IF COL_LENGTH('scm.Demand', 'DeletedAt') IS NULL
    ALTER TABLE scm.Demand ADD DeletedAt datetime2(0) NULL, DeletedBy int NULL CONSTRAINT FK_Demand_DeletedBy REFERENCES app.[User] (UserId);
GO
