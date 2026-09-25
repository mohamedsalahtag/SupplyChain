-- Demand-to-PO plan v5, Stage 0: workflow foundations (specs 10 and 11).
-- Companies and user scope, reason codes, origin map, work items (My work), domain events,
-- threads, attachments, command log, notification outbox, purchase history summary,
-- and the supplier / purchase-order sync additions.
CREATE SCHEMA scm;
GO

CREATE TABLE scm.Company (
    CompanyCode     nvarchar(10)  NOT NULL CONSTRAINT PK_Company PRIMARY KEY,
    Name            nvarchar(100) NOT NULL,
    Country         nvarchar(3)   NOT NULL,
    TimeZone        nvarchar(60)  NOT NULL,           -- IANA name, for confirmed ETD dates
    DefaultPlant    nvarchar(10)  NOT NULL,
    PurchasingOrg   nvarchar(10)  NOT NULL CONSTRAINT DF_Company_PurchasingOrg DEFAULT '',   -- '' = not set yet
    PurchasingGroup nvarchar(10)  NOT NULL CONSTRAINT DF_Company_PurchasingGroup DEFAULT '',
    IsActive        bit           NOT NULL CONSTRAINT DF_Company_IsActive DEFAULT 1,
    RowVer          rowversion    NOT NULL
);

CREATE TABLE scm.UserCompany (
    UserId      int          NOT NULL CONSTRAINT FK_UserCompany_User REFERENCES app.[User] (UserId) ON DELETE CASCADE,
    CompanyCode nvarchar(10) NOT NULL CONSTRAINT FK_UserCompany_Company REFERENCES scm.Company (CompanyCode),
    CONSTRAINT PK_UserCompany PRIMARY KEY (UserId, CompanyCode)
);

CREATE TABLE scm.ReasonCode (
    ReasonCode               nvarchar(40)  NOT NULL CONSTRAINT PK_ReasonCode PRIMARY KEY,
    Context                  nvarchar(40)  NOT NULL,  -- CR_SALES, CR_PROC, RELEASE, UNAWARD, HANDOFF_RETURN, SKU_CHANGE, PROCEED_NO_ACK
    Description              nvarchar(200) NOT NULL,
    CountsAgainstProcurement bit           NOT NULL CONSTRAINT DF_ReasonCode_Counts DEFAULT 0,
    IsActive                 bit           NOT NULL CONSTRAINT DF_ReasonCode_IsActive DEFAULT 1,
    RowVer                   rowversion    NOT NULL
);

-- SAP material origin names → ISO country codes (a supplier's origin is its SAP Country code).
CREATE TABLE scm.RefOrigin (
    OriginName    nvarchar(80) NOT NULL CONSTRAINT PK_RefOrigin PRIMARY KEY,   -- as in md.Material.Origin ('' = blank)
    CountryCode   nvarchar(3)  NULL,                                            -- NULL = unmatched or not a country
    Source        nvarchar(12) NOT NULL CONSTRAINT CK_RefOrigin_Source CHECK (Source IN ('Auto', 'Manual', 'NotCountry', 'Unmatched')),
    MaterialCount int          NOT NULL CONSTRAINT DF_RefOrigin_Count DEFAULT 0,
    UpdatedAt     datetime2(0) NOT NULL CONSTRAINT DF_RefOrigin_UpdatedAt DEFAULT SYSUTCDATETIME(),
    RowVer        rowversion   NOT NULL
);

-- Every business action, for Demand 360 timelines and audits.
CREATE TABLE scm.DomainEvent (
    EventId     bigint IDENTITY NOT NULL CONSTRAINT PK_DomainEvent PRIMARY KEY,
    EventType   nvarchar(60)  NOT NULL,
    EntityType  nvarchar(40)  NOT NULL,
    EntityId    nvarchar(40)  NOT NULL,
    DemandId    bigint        NULL,
    PayloadJson nvarchar(max) NULL,
    ActorUserId int           NULL,          -- NULL = system
    OccurredAt  datetime2(3)  NOT NULL CONSTRAINT DF_DomainEvent_At DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_DomainEvent_Entity ON scm.DomainEvent (EntityType, EntityId);
CREATE INDEX IX_DomainEvent_Demand ON scm.DomainEvent (DemandId, OccurredAt) WHERE DemandId IS NOT NULL;

CREATE TABLE scm.Thread (
    ThreadId   bigint IDENTITY NOT NULL CONSTRAINT PK_Thread PRIMARY KEY,
    EntityType nvarchar(40) NOT NULL,
    EntityId   nvarchar(40) NOT NULL,
    CONSTRAINT UQ_Thread UNIQUE (EntityType, EntityId)
);

CREATE TABLE scm.ThreadEntry (
    EntryId         bigint IDENTITY NOT NULL CONSTRAINT PK_ThreadEntry PRIMARY KEY,
    ThreadId        bigint        NOT NULL CONSTRAINT FK_ThreadEntry_Thread REFERENCES scm.Thread (ThreadId),
    EntryKind       nvarchar(20)  NOT NULL CONSTRAINT CK_ThreadEntry_Kind CHECK (EntryKind IN ('COMMENT', 'SYSTEM', 'DECISION', 'CLARIFICATION')),
    Body            nvarchar(max) NOT NULL,
    CorrectsEntryId bigint        NULL CONSTRAINT FK_ThreadEntry_Corrects REFERENCES scm.ThreadEntry (EntryId),
    EventId         bigint        NULL CONSTRAINT FK_ThreadEntry_Event REFERENCES scm.DomainEvent (EventId),
    AuthorUserId    int           NULL,
    CreatedAt       datetime2(3)  NOT NULL CONSTRAINT DF_ThreadEntry_At DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_ThreadEntry_Thread ON scm.ThreadEntry (ThreadId, CreatedAt);
GO

-- Thread entries are immutable: corrections are new entries.
CREATE TRIGGER scm.TR_ThreadEntry_Immutable ON scm.ThreadEntry INSTEAD OF UPDATE, DELETE AS
BEGIN
    THROW 51001, 'Thread entries cannot be changed or deleted; add a correction instead.', 1;
END;
GO

CREATE TABLE scm.NotificationOutbox (
    NotificationId   bigint IDENTITY NOT NULL CONSTRAINT PK_NotificationOutbox PRIMARY KEY,
    NotificationType nvarchar(60)  NOT NULL,
    RecipientPermission nvarchar(100) NULL,
    RecipientUserId  int           NULL,
    EntityType       nvarchar(40)  NOT NULL,
    EntityId         nvarchar(40)  NOT NULL,
    PayloadJson      nvarchar(max) NULL,
    Status           nvarchar(20)  NOT NULL CONSTRAINT DF_NotificationOutbox_Status DEFAULT 'QUEUED',   -- delivery: plan Stage 9
    CreatedAt        datetime2(0)  NOT NULL CONSTRAINT DF_NotificationOutbox_At DEFAULT SYSUTCDATETIME()
);

-- My work: one row per piece of work or exception. Opened and closed only by the service action that owns it.
CREATE TABLE scm.InboxItem (
    InboxItemId  bigint IDENTITY NOT NULL CONSTRAINT PK_InboxItem PRIMARY KEY,
    ItemType     nvarchar(60)   NOT NULL,
    Category     nvarchar(10)   NOT NULL CONSTRAINT CK_InboxItem_Category CHECK (Category IN ('TASK', 'EXCEPTION')),
    Permission   nvarchar(100)  NOT NULL,          -- who may act on it
    CompanyCode  nvarchar(10)   NULL,              -- NULL = system item, not tied to a company
    EntityType   nvarchar(40)   NOT NULL,
    EntityId     nvarchar(40)   NOT NULL,
    Number       nvarchar(40)   NOT NULL,          -- shown, e.g. D-000101
    Title        nvarchar(300)  NOT NULL,
    Note         nvarchar(1000) NULL,              -- what is missing / next action
    Link         nvarchar(300)  NOT NULL,          -- screen that resolves it
    RaisedBy     int            NULL,              -- NULL = system
    CreatedAt    datetime2(0)   NOT NULL CONSTRAINT DF_InboxItem_CreatedAt DEFAULT SYSUTCDATETIME(),
    DueAt        datetime2(0)   NULL,
    EscalatedAt  datetime2(0)   NULL,
    IsOpen       bit            NOT NULL CONSTRAINT DF_InboxItem_IsOpen DEFAULT 1,
    ClosedAt     datetime2(0)   NULL,
    ClosedBy     int            NULL
);
CREATE UNIQUE INDEX UX_InboxItem_OneOpen ON scm.InboxItem (ItemType, EntityType, EntityId) WHERE IsOpen = 1;
CREATE INDEX IX_InboxItem_Open ON scm.InboxItem (IsOpen, Permission, CompanyCode) INCLUDE (ItemType, DueAt);

-- Duplicate-safe commands: the client sends one id per user action.
CREATE TABLE scm.CommandLog (
    CommandId   uniqueidentifier NOT NULL CONSTRAINT PK_CommandLog PRIMARY KEY,
    UserId      int              NOT NULL,
    CommandName nvarchar(60)     NOT NULL,
    ResultJson  nvarchar(max)    NULL,
    CreatedAt   datetime2(0)     NOT NULL CONSTRAINT DF_CommandLog_At DEFAULT SYSUTCDATETIME()
);

CREATE TABLE scm.Attachment (
    AttachmentId bigint IDENTITY NOT NULL CONSTRAINT PK_Attachment PRIMARY KEY,
    EntityType   nvarchar(40)  NOT NULL,
    EntityId     nvarchar(40)  NOT NULL,
    CompanyCode  nvarchar(10)  NULL,
    FileName     nvarchar(260) NOT NULL,
    ContentType  nvarchar(100) NOT NULL,
    SizeBytes    bigint        NOT NULL,
    Sha256       char(64)      NOT NULL,
    StorageKey   nvarchar(400) NOT NULL,
    VersionNo    int           NOT NULL CONSTRAINT DF_Attachment_Version DEFAULT 1,
    SupersedesId bigint        NULL CONSTRAINT FK_Attachment_Supersedes REFERENCES scm.Attachment (AttachmentId),
    IsCurrent    bit           NOT NULL CONSTRAINT DF_Attachment_IsCurrent DEFAULT 1,
    UploadedBy   int           NOT NULL,
    UploadedAt   datetime2(0)  NOT NULL CONSTRAINT DF_Attachment_At DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_Attachment_Entity ON scm.Attachment (EntityType, EntityId, IsCurrent);
GO

-- Attachments are never deleted; a new version supersedes the old one.
CREATE TRIGGER scm.TR_Attachment_NoDelete ON scm.Attachment INSTEAD OF DELETE AS
BEGIN
    THROW 51002, 'Attachments cannot be deleted; upload a new version instead.', 1;
END;
GO

-- Purchase history per supplier × company × material key × origin (rebuilt after each PO sync).
CREATE TABLE scm.PurchaseHistorySummary (
    SupplierCode     nvarchar(20)   NOT NULL,
    CompanyCode      nvarchar(10)   NOT NULL,
    MajorCategory    nvarchar(80)   NOT NULL,
    SubMajorCategory nvarchar(80)   NOT NULL,
    Size             nvarchar(80)   NOT NULL,
    OriginCode       nvarchar(3)    NOT NULL,      -- '' = origin not mapped
    MaterialCode     nvarchar(40)   NOT NULL,      -- '' = all materials of the specification
    Unit             nvarchar(10)   NOT NULL,
    PoCount          int            NOT NULL,
    TotalQtyMilli    bigint         NOT NULL,
    FirstPoDate      date           NOT NULL,
    LastPoDate       date           NOT NULL,
    LastUnitPrice    decimal(18, 4) NULL,
    LastCurrency     nvarchar(5)    NULL,
    RefreshedAt      datetime2(0)   NOT NULL CONSTRAINT DF_PHS_At DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_PurchaseHistorySummary PRIMARY KEY (SupplierCode, CompanyCode, MajorCategory, SubMajorCategory, Size, OriginCode, MaterialCode, Unit)
);
GO

-- Supplier sync additions: blocks and purchasing organizations.
ALTER TABLE md.Supplier ADD
    PurchasingIsBlocked bit NOT NULL CONSTRAINT DF_Supplier_PurchBlocked DEFAULT 0,
    PostingIsBlocked    bit NOT NULL CONSTRAINT DF_Supplier_PostBlocked DEFAULT 0;

CREATE TABLE md.SupplierPurchasingOrg (
    SupplierCode  nvarchar(20) NOT NULL,
    PurchasingOrg nvarchar(10) NOT NULL,
    IsBlocked     bit          NOT NULL,
    CONSTRAINT PK_SupplierPurchasingOrg PRIMARY KEY (SupplierCode, PurchasingOrg)
);

-- Purchase order sync additions.
ALTER TABLE md.PurchaseOrder ADD
    CompanyCode     nvarchar(10) NOT NULL CONSTRAINT DF_PurchaseOrder_Company DEFAULT '',
    PurchasingOrg   nvarchar(10) NOT NULL CONSTRAINT DF_PurchaseOrder_PurchOrg DEFAULT '',
    PurchasingGroup nvarchar(10) NOT NULL CONSTRAINT DF_PurchaseOrder_PurchGroup DEFAULT '';
GO
CREATE INDEX IX_PurchaseOrder_Company ON md.PurchaseOrder (CompanyCode);

-- Existing orders lack the new columns: the next PO sync must be a full one.
DELETE FROM app.Setting WHERE SettingKey = 'sap.po.watermark';

-- Seed data.
INSERT INTO scm.Company (CompanyCode, Name, Country, TimeZone, DefaultPlant) VALUES
    ('1000', 'KSA',     'SA', 'Asia/Riyadh',  'HO01'),
    ('2000', 'UAE',     'AE', 'Asia/Dubai',   'HO01'),
    ('3000', 'Bahrain', 'BH', 'Asia/Bahrain', 'HO01');

INSERT INTO scm.ReasonCode (ReasonCode, Context, Description, CountsAgainstProcurement) VALUES
    ('CUST_CANCEL',   'CR_SALES',       'Customer cancelled or reduced the order', 0),
    ('FORECAST_CHG',  'CR_SALES',       'Sales forecast changed', 0),
    ('SPEC_CHANGE',   'CR_SALES',       'Customer changed the specification', 0),
    ('NO_SUPPLY',     'CR_PROC',        'No supplier could supply in time', 1),
    ('PRICE_HIGH',    'CR_PROC',        'Quoted prices above budget', 1),
    ('MARKET_OPP',    'CR_PROC',        'Market opportunity (extra quantity)', 0),
    ('WEEK_AVAIL',    'CR_PROC',        'Supply available only in another week', 0),
    ('QTY_NOT_NEEDED','RELEASE',        'Quantity not needed on this RFQ', 0),
    ('SUPPLIER_OUT',  'UNAWARD',        'Supplier withdrew or cannot deliver', 0),
    ('SKU_ISSUE',     'HANDOFF_RETURN', 'Provided SKU is wrong', 0),
    ('TERMS',         'HANDOFF_RETURN', 'Shipping terms incomplete or wrong', 0),
    ('SHIPMENT',      'HANDOFF_RETURN', 'Containers or ETD wrong', 0),
    ('DATA',          'HANDOFF_RETURN', 'Other data problem', 0),
    ('SKU_CORRECT',   'SKU_CHANGE',     'SKU corrected within the same specification', 0),
    ('URGENT',        'PROCEED_NO_ACK', 'Urgent: supplier deadline before Sales could acknowledge', 0);

-- The Home screen becomes My work: carry the permission over.
UPDATE app.RolePermission SET PermissionKey = 'work.open' WHERE PermissionKey = 'home.open';
