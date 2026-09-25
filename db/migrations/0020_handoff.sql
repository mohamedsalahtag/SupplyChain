-- Demand-to-PO plan v5, Stage 6: shipping terms and the handoff of each supplier's award to the PO team (spec 22).

-- Reference lists (Configuration → Shipping terms). Payment terms come from SAP (codes); Incoterms and ports are kept here.
CREATE TABLE scm.Incoterm (
    Code        nvarchar(10)  NOT NULL CONSTRAINT PK_Incoterm PRIMARY KEY,
    Description nvarchar(100) NOT NULL,
    IsActive    bit           NOT NULL CONSTRAINT DF_Incoterm_Active DEFAULT 1,
    SortOrder   int           NOT NULL
);
INSERT INTO scm.Incoterm (Code, Description, IsActive, SortOrder) VALUES
    ('EXW', 'Ex works', 0, 1), ('FCA', 'Free carrier', 1, 2), ('CPT', 'Carriage paid to', 0, 3), ('CIP', 'Carriage and insurance paid to', 0, 4),
    ('DAP', 'Delivered at place', 0, 5), ('DPU', 'Delivered at place unloaded', 0, 6), ('DDP', 'Delivered duty paid', 0, 7),
    ('FAS', 'Free alongside ship', 0, 8), ('FOB', 'Free on board', 1, 9), ('CFR', 'Cost and freight', 1, 10), ('CIF', 'Cost, insurance and freight', 1, 11);

CREATE TABLE scm.Port (
    PortId      int IDENTITY  NOT NULL CONSTRAINT PK_Port PRIMARY KEY,
    Name        nvarchar(80)  NOT NULL,
    CountryCode nvarchar(3)   NOT NULL,
    UsedFor     nvarchar(10)  NOT NULL CONSTRAINT CK_Port_UsedFor CHECK (UsedFor IN ('LOADING', 'DISCHARGE', 'BOTH')),
    IsActive    bit           NOT NULL CONSTRAINT DF_Port_Active DEFAULT 1,
    CONSTRAINT UQ_Port UNIQUE (Name, CountryCode)
);
-- A starting list; an administrator keeps it (Configuration → Shipping terms).
INSERT INTO scm.Port (Name, CountryCode, UsedFor) VALUES
    ('Jeddah', 'SA', 'DISCHARGE'), ('Dammam', 'SA', 'DISCHARGE'), ('Valparaíso', 'CL', 'LOADING'), ('San Antonio', 'CL', 'LOADING');

CREATE TABLE scm.PaymentTerm (
    Code        nvarchar(10)  NOT NULL CONSTRAINT PK_PaymentTerm PRIMARY KEY,   -- the SAP code (ZTERM)
    Description nvarchar(100) NOT NULL CONSTRAINT DF_PaymentTerm_Desc DEFAULT '',
    IsActive    bit           NOT NULL CONSTRAINT DF_PaymentTerm_Active DEFAULT 1
);

-- The supplier sync also brings each supplier's payment terms and Incoterm per purchasing organization (SAP A_SupplierPurchasingOrg).
ALTER TABLE md.SupplierPurchasingOrg ADD
    PaymentTerms     nvarchar(10) NOT NULL CONSTRAINT DF_SupplierPurchasingOrg_Pay DEFAULT '',
    Incoterm         nvarchar(10) NOT NULL CONSTRAINT DF_SupplierPurchasingOrg_Inco DEFAULT '',
    IncotermLocation nvarchar(80) NOT NULL CONSTRAINT DF_SupplierPurchasingOrg_Loc DEFAULT '';
GO

-- Shipping terms per award batch × supplier (editable until handed off; copied into each handoff's snapshot).
CREATE TABLE scm.ShippingTerms (
    ShippingTermsId   bigint IDENTITY NOT NULL CONSTRAINT PK_ShippingTerms PRIMARY KEY,
    AwardBatchId      bigint       NOT NULL CONSTRAINT FK_ShippingTerms_Batch REFERENCES scm.AwardBatch (AwardBatchId),
    SupplierCode      nvarchar(20) NOT NULL,
    Incoterm          nvarchar(10) NULL CONSTRAINT FK_ShippingTerms_Incoterm REFERENCES scm.Incoterm (Code),
    PortOfLoadingId   int          NULL CONSTRAINT FK_ShippingTerms_Pol REFERENCES scm.Port (PortId),
    PortOfDischargeId int          NULL CONSTRAINT FK_ShippingTerms_Pod REFERENCES scm.Port (PortId),
    PaymentTerms      nvarchar(10) NULL CONSTRAINT FK_ShippingTerms_Pay REFERENCES scm.PaymentTerm (Code),
    Currency          char(3)      NULL,
    IsComplete AS (CASE WHEN Incoterm IS NOT NULL AND PortOfLoadingId IS NOT NULL AND PortOfDischargeId IS NOT NULL
                         AND PaymentTerms IS NOT NULL AND Currency IS NOT NULL THEN 1 ELSE 0 END),
    UpdatedBy         int          NULL CONSTRAINT FK_ShippingTerms_User REFERENCES app.[User] (UserId),
    UpdatedAt         datetime2(0) NULL,
    RowVer            rowversion   NOT NULL,
    CONSTRAINT UQ_ShippingTerms UNIQUE (AwardBatchId, SupplierCode)
);

CREATE SEQUENCE scm.HandoffNoSeq AS bigint START WITH 1 INCREMENT BY 1;

-- One handoff = one supplier of one award = one PO (Stage 7). Each send is a new row; a returned one keeps its snapshot.
CREATE TABLE scm.Handoff (
    HandoffId        bigint IDENTITY NOT NULL CONSTRAINT PK_Handoff PRIMARY KEY,
    HoNo             nvarchar(20)  NOT NULL CONSTRAINT UQ_Handoff_No UNIQUE,   -- HO-000001
    AwardBatchId     bigint        NOT NULL CONSTRAINT FK_Handoff_Batch REFERENCES scm.AwardBatch (AwardBatchId),
    SupplierCode     nvarchar(20)  NOT NULL,
    CompanyCode      nvarchar(10)  NOT NULL,
    Status           nvarchar(12)  NOT NULL CONSTRAINT CK_Handoff_Status CHECK (Status IN ('HANDED_OFF', 'ACCEPTED', 'RETURNED')),
    HandedOffQty     bigint        NOT NULL,          -- milli, all units together (for the list; the snapshot has the detail)
    SnapshotJson     nvarchar(max) NOT NULL,          -- supplier, terms, shipments, items, ack revision — exactly as sent
    SentBy           int           NOT NULL CONSTRAINT FK_Handoff_SentBy REFERENCES app.[User] (UserId),
    SentAt           datetime2(0)  NOT NULL CONSTRAINT DF_Handoff_SentAt DEFAULT SYSUTCDATETIME(),
    SentWithoutAck   bit           NOT NULL CONSTRAINT DF_Handoff_NoAck DEFAULT 0,
    ProceedReason    nvarchar(40)  NULL,              -- PROCEED_NO_ACK reason when sent without the acknowledgement
    ProceedComment   nvarchar(1000) NULL,
    AckRevision      int           NOT NULL,
    AcceptedBy       int           NULL CONSTRAINT FK_Handoff_AcceptedBy REFERENCES app.[User] (UserId),
    AcceptedAt       datetime2(0)  NULL,
    ReturnedBy       int           NULL CONSTRAINT FK_Handoff_ReturnedBy REFERENCES app.[User] (UserId),   -- NULL for an automatic return
    ReturnedAt       datetime2(0)  NULL,
    ReturnedFrom     nvarchar(12)  NULL,
    ReturnReason     nvarchar(40)  NULL,              -- SKU_ISSUE, TERMS, SHIPMENT, DATA, OTHER, CR_CHANGE
    ReturnComment    nvarchar(2000) NULL,
    ReturnCrId       bigint        NULL CONSTRAINT FK_Handoff_Cr REFERENCES scm.ChangeRequest (CrId),
    RowVer           rowversion    NOT NULL
);
CREATE UNIQUE INDEX UX_Handoff_Open ON scm.Handoff (AwardBatchId, SupplierCode) WHERE Status IN ('HANDED_OFF', 'ACCEPTED');
CREATE INDEX IX_Handoff_Status ON scm.Handoff (Status, CompanyCode);
ALTER TABLE scm.QtySlice ADD CONSTRAINT FK_QtySlice_Handoff FOREIGN KEY (HandoffId) REFERENCES scm.Handoff (HandoffId);
GO

-- Return / proceed reasons not seeded yet.
INSERT INTO scm.ReasonCode (ReasonCode, Context, Description, CountsAgainstProcurement)
SELECT v.c, v.x, v.d, v.r FROM (VALUES
    ('OTHER_RETURN', 'HANDOFF_RETURN', 'Other (explain in the comment)', 0),
    ('CR_CHANGE',    'HANDOFF_AUTO',   'Quantity changed by a change request', 0),
    ('OTHER_NO_ACK', 'PROCEED_NO_ACK', 'Other (explain in the comment)', 0)) v (c, x, d, r)
WHERE NOT EXISTS (SELECT 1 FROM scm.ReasonCode r WHERE r.ReasonCode = v.c);

-- The PO creation team (spec 22): accepts or returns handoffs.
INSERT INTO app.Role (Name, Description)
SELECT 'PO team', 'Accepts or returns handoffs and prepares the purchase orders.'
WHERE NOT EXISTS (SELECT 1 FROM app.Role WHERE Name = 'PO team');

INSERT INTO app.RolePermission (RoleId, PermissionKey)
SELECT r.RoleId, p.k FROM app.Role r
JOIN (VALUES ('PO team', 'work.open'), ('PO team', 'handoffs.open'), ('PO team', 'handoff.accept'), ('PO team', 'handoff.return'),
             ('PO team', 'awards.open'), ('PO team', 'demands.open'), ('PO team', 'suppliers.open'), ('PO team', 'materials.open'),
             ('Procurement', 'handoffs.open'), ('Procurement', 'handoff.send'), ('Sales', 'handoffs.open')) AS p(RoleName, k) ON p.RoleName = r.Name
WHERE NOT EXISTS (SELECT 1 FROM app.RolePermission x WHERE x.RoleId = r.RoleId AND x.PermissionKey = p.k);

INSERT INTO app.[User] (Username, Upn, DisplayName, Email, Department, Title, IsActive, CreatedBy, IsDemo)
SELECT 'demo.po', '', 'Demo PO team', '', 'PO team', 'Demo account for testing', 1, 'migration 0020', 1
WHERE NOT EXISTS (SELECT 1 FROM app.[User] WHERE Username = 'demo.po');

INSERT INTO app.UserRole (UserId, RoleId)
SELECT u.UserId, r.RoleId FROM app.[User] u JOIN app.Role r ON r.Name = 'PO team'
WHERE u.Username = 'demo.po' AND NOT EXISTS (SELECT 1 FROM app.UserRole x WHERE x.UserId = u.UserId AND x.RoleId = r.RoleId);

INSERT INTO scm.UserCompany (UserId, CompanyCode)
SELECT u.UserId, c.CompanyCode FROM app.[User] u CROSS JOIN scm.Company c
WHERE u.Username = 'demo.po' AND NOT EXISTS (SELECT 1 FROM scm.UserCompany x WHERE x.UserId = u.UserId AND x.CompanyCode = c.CompanyCode);
