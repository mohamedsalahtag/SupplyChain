-- Suppliers (API_BUSINESS_PARTNER) and purchase orders (API_PURCHASEORDER_2) copied from SAP.
CREATE TABLE md.Supplier (
    SupplierCode   nvarchar(20)   NOT NULL CONSTRAINT PK_Supplier PRIMARY KEY,
    Name           nvarchar(200)  NOT NULL,
    SupplierGroup  nvarchar(10)   NOT NULL,
    Country        nvarchar(3)    NOT NULL,
    Currency       nvarchar(5)    NOT NULL,
    Street         nvarchar(200)  NOT NULL,
    HouseNumber    nvarchar(40)   NOT NULL,
    City           nvarchar(100)  NOT NULL,
    PostalCode     nvarchar(20)   NOT NULL,
    Region         nvarchar(10)   NOT NULL,
    Email          nvarchar(250)  NOT NULL,
    InSap          bit            NOT NULL CONSTRAINT DF_Supplier_InSap DEFAULT 1,
    SapChangedAt   datetime2(0)   NOT NULL CONSTRAINT DF_Supplier_SapChangedAt DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_Supplier_Group ON md.Supplier (SupplierGroup);
GO

CREATE TABLE md.PurchaseOrder (
    PurchaseOrder    nvarchar(20)  NOT NULL CONSTRAINT PK_PurchaseOrder PRIMARY KEY,
    OrderType        nvarchar(10)  NOT NULL,
    SupplierCode     nvarchar(20)  NOT NULL,
    OrderDate        date          NOT NULL,
    Currency         nvarchar(5)   NOT NULL,
    SapLastChangedAt datetime2(3)  NULL,          -- SAP's LastChangeDateTime
    SapChangedAt     datetime2(0)  NOT NULL CONSTRAINT DF_PurchaseOrder_SapChangedAt DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_PurchaseOrder_Supplier ON md.PurchaseOrder (SupplierCode);
CREATE INDEX IX_PurchaseOrder_TypeDate ON md.PurchaseOrder (OrderType, OrderDate);

CREATE TABLE md.PurchaseOrderLine (
    PurchaseOrder  nvarchar(20)   NOT NULL CONSTRAINT FK_PurchaseOrderLine_PO REFERENCES md.PurchaseOrder (PurchaseOrder) ON DELETE CASCADE,
    ItemNo         int            NOT NULL,
    Material       nvarchar(40)   NOT NULL,
    Quantity       decimal(18, 3) NOT NULL,
    Unit           nvarchar(10)   NOT NULL,
    NetPrice       decimal(18, 4) NOT NULL,
    PriceQuantity  decimal(18, 3) NOT NULL,   -- the price is per this many units
    CONSTRAINT PK_PurchaseOrderLine PRIMARY KEY (PurchaseOrder, ItemNo)
);
CREATE INDEX IX_PurchaseOrderLine_Material ON md.PurchaseOrderLine (Material);
