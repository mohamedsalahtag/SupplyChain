import type { Generated } from 'kysely';

/**
 * Kysely table types. Keep in step with db/migrations — one entry per table,
 * keyed as '<schema>.<table>'.
 */
export interface Database {
  'app.Setting': {
    SettingKey: string;
    SettingValue: string | null;
    UpdatedAt: Date;
  };
  'app.UserPreference': {
    UserId: string;
    PrefKey: string;
    PrefValue: string;
    UpdatedAt: Date;
  };
  'app.User': {
    UserId: Generated<number>;
    Username: string;
    Upn: string;
    DisplayName: string;
    Email: string;
    Department: string;
    Title: string;
    IsActive: boolean;
    CreatedAt: Generated<Date>;
    CreatedBy: string;
    LastLoginAt: Date | null;
    IsDemo: Generated<boolean>;
  };
  'app.Role': {
    RoleId: Generated<number>;
    Name: string;
    Description: string;
    IsAdmin: Generated<boolean>;
    IsBuiltIn: Generated<boolean>;
    IsActive: Generated<boolean>;
  };
  'app.RolePermission': { RoleId: number; PermissionKey: string };
  'app.UserRole': { UserId: number; RoleId: number };
  'app.AuditLog': {
    AuditId: Generated<number>;
    At: Generated<Date>;
    UserId: number | null;
    Action: string;
    Target: string;
    Details: string | null;
  };
  'md.Material': {
    MaterialCode: string;
    Description: string;
    MajorCategoryCode: string;
    MajorCategory: string;
    SubMajorCategory: string;
    MaterialGroupCode: string;
    MaterialGroup: string;
    MaterialType: string;
    BaseUnit: string;
    BaseUnitName: string;
    Origin: string;
    Variety: string;
    Size: string;
    Weight: number | null;
    WeightUnit: string;
    MaterialClassCode: string;
    MaterialClass: string;
    InSap: boolean;
    SapChangedAt: Date;
  };
  'md.Supplier': {
    SupplierCode: string;
    Name: string;
    SupplierGroup: string;
    Country: string;
    Currency: string;
    Street: string;
    HouseNumber: string;
    City: string;
    PostalCode: string;
    Region: string;
    Email: string;
    PurchasingIsBlocked: Generated<boolean>;
    PostingIsBlocked: Generated<boolean>;
    InSap: boolean;
    SapChangedAt: Date;
  };
  'md.SupplierPurchasingOrg': { SupplierCode: string; PurchasingOrg: string; IsBlocked: boolean; PaymentTerms: Generated<string>; Incoterm: Generated<string>; IncotermLocation: Generated<string> };
  'md.PurchaseOrder': {
    PurchaseOrder: string;
    OrderType: string;
    SupplierCode: string;
    OrderDate: Date;
    Currency: string;
    CompanyCode: Generated<string>;
    PurchasingOrg: Generated<string>;
    PurchasingGroup: Generated<string>;
    SapLastChangedAt: Date | null;
    SapChangedAt: Date;
  };
  'md.PurchaseOrderLine': {
    PurchaseOrder: string;
    ItemNo: number;
    Material: string;
    Quantity: number;
    Unit: string;
    NetPrice: number;
    PriceQuantity: number;
  };
  'integ.SyncRun': {
    SyncRunId: Generated<number>;
    Source: string;
    Status: 'Running' | 'Succeeded' | 'Failed';
    StartedAt: Generated<Date>;
    StartedBy: string;
    FinishedAt: Date | null;
    RowsRead: number | null;
    RowsInserted: number | null;
    RowsUpdated: number | null;
    RowsMarkedMissing: number | null;
    Message: string | null;
  };

  // ---- scm: Demand-to-PO workflow (plan v5) ----
  'scm.Company': {
    CompanyCode: string;
    Name: string;
    Country: string;
    TimeZone: string;
    DefaultPlant: string;
    PurchasingOrg: Generated<string>;
    PurchasingGroup: Generated<string>;
    IsActive: Generated<boolean>;
  };
  'scm.UserCompany': { UserId: number; CompanyCode: string };
  'scm.ReasonCode': {
    ReasonCode: string;
    Context: string;
    Description: string;
    CountsAgainstProcurement: Generated<boolean>;
    IsActive: Generated<boolean>;
  };
  'scm.RefOrigin': {
    OriginName: string;
    CountryCode: string | null;
    Source: 'Auto' | 'Manual' | 'NotCountry' | 'Unmatched';
    MaterialCount: Generated<number>;
    UpdatedAt: Generated<Date>;
  };
  'scm.DomainEvent': {
    EventId: Generated<string>;
    EventType: string;
    EntityType: string;
    EntityId: string;
    DemandId: string | null;
    PayloadJson: string | null;
    ActorUserId: number | null;
    OccurredAt: Generated<Date>;
  };
  'scm.Thread': { ThreadId: Generated<string>; EntityType: string; EntityId: string };
  'scm.ThreadEntry': {
    EntryId: Generated<string>;
    ThreadId: string;
    EntryKind: 'COMMENT' | 'SYSTEM' | 'DECISION' | 'CLARIFICATION';
    Body: string;
    CorrectsEntryId: string | null;
    EventId: string | null;
    AuthorUserId: number | null;
    CreatedAt: Generated<Date>;
  };
  'scm.NotificationOutbox': {
    NotificationId: Generated<string>;
    NotificationType: string;
    RecipientPermission: string | null;
    RecipientUserId: number | null;
    EntityType: string;
    EntityId: string;
    PayloadJson: string | null;
    Status: Generated<string>;
    CreatedAt: Generated<Date>;
  };
  'scm.InboxItem': {
    InboxItemId: Generated<string>;
    ItemType: string;
    Category: 'TASK' | 'EXCEPTION';
    Permission: string;
    CompanyCode: string | null;
    EntityType: string;
    EntityId: string;
    Number: string;
    Title: string;
    Note: string | null;
    Link: string;
    RaisedBy: number | null;
    CreatedAt: Generated<Date>;
    DueAt: Date | null;
    EscalatedAt: Date | null;
    IsOpen: Generated<boolean>;
    ClosedAt: Date | null;
    ClosedBy: number | null;
    ExcludeUserId: Generated<number | null>;
  };
  'scm.CommandLog': { CommandId: string; UserId: number; CommandName: string; ResultJson: string | null; CreatedAt: Generated<Date> };
  'scm.Attachment': {
    AttachmentId: Generated<string>;
    EntityType: string;
    EntityId: string;
    CompanyCode: string | null;
    FileName: string;
    ContentType: string;
    SizeBytes: string | number;
    Sha256: string;
    StorageKey: string;
    VersionNo: Generated<number>;
    SupersedesId: string | null;
    IsCurrent: Generated<boolean>;
    UploadedBy: number;
    UploadedAt: Generated<Date>;
  };
  'scm.PurchaseHistorySummary': {
    SupplierCode: string;
    CompanyCode: string;
    MajorCategory: string;
    SubMajorCategory: string;
    Size: string;
    OriginCode: string;
    MaterialCode: string;
    Unit: string;
    PoCount: number;
    TotalQtyMilli: string;
    FirstPoDate: Date;
    LastPoDate: Date;
    LastUnitPrice: number | null;
    LastCurrency: string | null;
    RefreshedAt: Generated<Date>;
  };

  'scm.Demand': {
    DemandId: Generated<string>;
    DemandNo: string;
    CompanyCode: string;
    WorkflowStatus: Generated<DemandWorkflowStatus>;
    CurrentVersion: Generated<number>;
    BaselineVersion: number | null;
    BaselineStatus: Generated<'AVAILABLE' | 'NOT_AVAILABLE'>;
    Notes: Generated<string>;
    CreatedBy: number;
    CreatedAt: Generated<Date>;
    SubmittedAt: Date | null;
    AcceptedAt: Date | null;
    AcceptedBy: number | null;
  };
  'scm.DemandWeek': { DemandWeekId: Generated<string>; DemandId: string; EtdWeek: string; ContainerCount: number };
  'scm.DemandLine': {
    LineId: Generated<string>;
    DemandId: string;
    DemandWeekId: string;
    LineNumber: number;
    SpecMode: 'SPEC' | 'SKU';
    MajorCategory: string;
    SubMajorCategory: string;
    Size: string;
    OriginCode: string;
    MaterialClass: Generated<string>;
    MaterialCode: string | null;
    Unit: string;
    RequestedQty: string | number;
    LineKey: Generated<string>;
    IsActive: Generated<boolean>;
    ChangeHoldCrId: string | null;
  };
  'scm.DemandKeyUom': { DemandId: string; LineKey: string; Unit: string };
  'scm.ContainerGroup': {
    ContainerGroupId: Generated<string>; DemandId: string; DemandWeekId: string; GroupNumber: number; Name: Generated<string>; IsActive: Generated<boolean>;
    ContainerCount: number; CapacityQty: string | number; Unit: string;
    /** Spec 17: the merge that brought this copy in / moved this group out, and the group it was copied from. */
    MergedInBy: Generated<string | null>; MergedOutBy: Generated<string | null>; SourceGroupId: Generated<string | null>;
  };
  'scm.MergeRecord': {
    MergeId: Generated<string>; MergeNo: string; SourceDemandId: string; TargetDemandId: string; CompanyCode: string; Scope: 'WEEKS' | 'DEMAND';
    Status: Generated<'EXECUTED' | 'UNMERGED'>; Comment: Generated<string>; ExecutedBy: number; ExecutedAt: Generated<Date>;
    UnmergedBy: number | null; UnmergedAt: Date | null; UnmergeReason: string | null; RowVer: Generated<Buffer>;
  };
  'scm.SupplierOrigin': { SupplierCode: string; OriginCode: string; Source: 'COUNTRY' | 'HISTORY' | 'MANUAL' | 'RFQ'; AddedBy: number | null; AddedAt: Generated<Date> };
  'scm.Rfq': {
    RfqId: Generated<string>; RfqNo: string; DemandId: string; CompanyCode: string; ManualStatus: Generated<'DRAFT' | 'SENT' | 'CANCELLED'>;
    CreatedBy: number; CreatedAt: Generated<Date>; SentBy: number | null; SentAt: Date | null; CancelledBy: number | null; CancelledAt: Date | null;
    CancelReason: string | null; CancelComment: string | null; RowVer: Generated<Buffer>;
  };
  'scm.RfqSupplier': { RfqId: string; SupplierCode: string; OriginsAtInvite: string; ShortlistRank: number | null; HintJson: string | null; InvitedBy: number; InvitedAt: Generated<Date>; OutsideShortlist: Generated<boolean> };
  'scm.RfqWeek': { RfqId: string; EtdWeek: string; ContainerCount: number; DefaultCount: number; RowVer: Generated<Buffer> };
  'scm.RfqLine': {
    RfqLineId: Generated<string>; RfqId: string; DemandLineId: string | null; Origin: Generated<'DEMAND' | 'PROCUREMENT'>;
    MajorCategory: string; SubMajorCategory: string; Size: string; MaterialClass: string; OriginCode: string; MaterialCode: string | null; Unit: string;
    LineKey: Generated<string>; ProposedEtdWeek: string; AskedQty: string | number; IsCancelled: Generated<boolean>; RowVer: Generated<Buffer>;
    /** Spec 19: a Procurement-proposed line before Sales decides, and a week shift. */
    ProposedQty: Generated<string | number | null>; AddCrId: Generated<string | null>; WeekShiftCrId: Generated<string | null>; PreviousEtdWeek: Generated<string | null>;
  };
  'scm.SupplierQuote': {
    QuoteId: Generated<string>; RfqId: string; SupplierCode: string; EtdWeek: string; LineKey: string; OriginCode: string; Unit: string; QuotedSku: string | null;
    UnitPrice: string | number; Currency: string; AvailableQty: string | number; ContainersOffered: number | null; OriginsAtQuote: string;
    IsCurrent: Generated<boolean>; SupersededBy: string | null; RecordedBy: number; RecordedAt: Generated<Date>;
  };
  /** Spec 18 revision: containers offered per supplier × week (not per material). */
  'scm.SupplierQuoteWeek': { RfqId: string; SupplierCode: string; EtdWeek: string; ContainersOffered: number; RecordedBy: number; RecordedAt: Generated<Date> };
  'scm.AwardBatch': { AwardBatchId: Generated<string>; AbNo: string; RfqId: string; DemandId: string; CompanyCode: string; Comment: Generated<string>; CreatedBy: number; CreatedAt: Generated<Date>; RowVer: Generated<Buffer> };
  'scm.AwardItem': {
    AwardItemId: Generated<string>; AwardBatchId: string; RfqLineId: string; SupplierCode: string; EtdWeek: string; LineKey: string; Qty: string | number; Unit: string;
    QuoteId: string; UnitPrice: string | number; Currency: string; OverrideReason: string | null; ByContainers: Generated<boolean>;
    SkuStatus: Generated<'RESOLVED_AT_DEMAND' | 'RESOLVED_AT_RFQ' | 'PENDING' | 'RESOLVED_AT_PO' | 'PENDING_MASTER_DATA'>; IsActive: Generated<boolean>; RowVer: Generated<Buffer>;
  };
  'scm.AwardItemChange': {
    ChangeId: Generated<string>; AwardItemId: string; ChangeType: 'UNAWARD_KEEP_QUOTES' | 'UNAWARD_RELEASE' | 'CANCELLED_BY_CR' | 'SKU_CORRECTED';
    Qty: string | number | null; ReasonCode: string | null; DetailJson: string | null; CrId: string | null; ActorUserId: number; ChangedAt: Generated<Date>;
  };
  'scm.AwardShipment': {
    ShipmentId: Generated<string>; AwardBatchId: string; SupplierCode: string; EtdWeek: string; ContainerCount: number; ConfirmedEtd: Date | string | null;
    IsActive: Generated<boolean>; UpdatedBy: number; UpdatedAt: Generated<Date>; RowVer: Generated<Buffer>;
  };
  /** Spec 20 revision 1: containers of a container group awarded to a supplier, and the container log. */
  'scm.AwardContainer': {
    AwardContainerId: Generated<string>; AwardBatchId: string; ContainerGroupId: string; SupplierCode: string; EtdWeek: string; Containers: number;
    IsActive: Generated<boolean>; CreatedAt: Generated<Date>; RowVer: Generated<Buffer>;
  };
  'scm.AwardContainerChange': {
    ChangeId: Generated<string>; AwardBatchId: string; AwardContainerId: string | null; ContainerGroupId: string | null;
    ChangeType: 'ABOVE_OFFER' | 'CONTAINERS_ADDED' | 'UNAWARD_KEEP_QUOTES' | 'UNAWARD_RELEASE'; SupplierCode: string | null; EtdWeek: string; Containers: number;
    Offered: number | null; Note: Generated<string>; ReasonCode: string | null; ActorUserId: number; ChangedAt: Generated<Date>;
  };
  /** Stage 6 (spec 22). */
  'scm.Incoterm': { Code: string; Description: string; IsActive: Generated<boolean>; SortOrder: number };
  'scm.Port': { PortId: Generated<number>; Name: string; CountryCode: string; UsedFor: 'LOADING' | 'DISCHARGE' | 'BOTH'; IsActive: Generated<boolean> };
  'scm.PaymentTerm': { Code: string; Description: Generated<string>; IsActive: Generated<boolean> };
  'scm.ShippingTerms': {
    ShippingTermsId: Generated<string>; AwardBatchId: string; SupplierCode: string; Incoterm: string | null; PortOfLoadingId: number | null; PortOfDischargeId: number | null;
    PaymentTerms: string | null; Currency: string | null; IsComplete: Generated<number>; UpdatedBy: number | null; UpdatedAt: Date | null; RowVer: Generated<Buffer>;
  };
  'scm.Handoff': {
    HandoffId: Generated<string>; HoNo: string; AwardBatchId: string; SupplierCode: string; CompanyCode: string; Status: 'HANDED_OFF' | 'ACCEPTED' | 'RETURNED';
    HandedOffQty: string | number; SnapshotJson: string; SentBy: number; SentAt: Generated<Date>; SentWithoutAck: Generated<boolean>; ProceedReason: string | null; ProceedComment: string | null;
    AckRevision: number; AcceptedBy: number | null; AcceptedAt: Date | null; ReturnedBy: number | null; ReturnedAt: Date | null; ReturnedFrom: string | null;
    ReturnReason: string | null; ReturnComment: string | null; ReturnCrId: string | null; RowVer: Generated<Buffer>;
  };
  /** Stage 7 (spec 23). */
  'scm.MasterDataRequest': { MdrId: Generated<string>; AwardItemId: string; Note: string; Status: Generated<'OPEN' | 'DONE'>; CreatedBy: number; CreatedAt: Generated<Date>; ClosedBy: number | null; ClosedAt: Date | null };
  'scm.PoDraft': {
    PoDraftId: Generated<string>; PoDraftNo: string; HandoffId: string; CompanyCode: string; SupplierCode: string; Plant: string; PurchasingOrg: string; PurchasingGroup: string;
    Incoterm: string; PortOfLoading: string; PortOfDischarge: string; PaymentTerms: string; Currency: string; ContainerCount: number;
    Status: Generated<'DRAFT' | 'VALIDATED' | 'SUBMITTED' | 'UNKNOWN' | 'CREATED' | 'REJECTED' | 'VOID'>; SapPoNumber: string | null; SapCreatedAt: Date | null;
    Resolution: 'SAP_REPLY' | 'RECONCILED' | 'MANUAL_CREATED' | 'MANUAL_NOT_CREATED' | null; LastError: string | null; ValidatedAt: Date | null;
    SubmittedBy: number | null; SubmittedAt: Date | null; CreatedBy: number; CreatedAt: Generated<Date>; RowVer: Generated<Buffer>;
  };
  'scm.PoDraftItem': {
    PoDraftItemId: Generated<string>; PoDraftId: string; ItemNo: number; AwardItemId: string; AllocId: string; DemandId: string; DemandLineId: string; MaterialCode: string;
    Qty: string | number; Unit: string; UnitPrice: string | number; Currency: string; EtdWeek: string; ConfirmedEtd: Date | string; SapItemNo: string | null;
  };
  'scm.SapSubmission': {
    SubmissionId: Generated<string>; PoDraftId: string; IdempotencyKey: string; Reference: string; PayloadJson: string; PayloadSha256: string;
    Status: Generated<'PENDING' | 'IN_FLIGHT' | 'CREATED' | 'REJECTED' | 'UNKNOWN' | 'MANUAL'>; Attempts: Generated<number>; ReconcileChecks: Generated<number>;
    ClaimedBy: string | null; LeaseUntil: Date | null; NextActionAt: Generated<Date>; CreatedAt: Generated<Date>;
  };
  'scm.SapSubmissionAttempt': { AttemptId: Generated<string>; SubmissionId: string; Kind: 'CREATE' | 'LOOKUP'; StartedAt: Date; FinishedAt: Date | null; Outcome: string | null; Detail: string | null; WorkerId: string };
  'scm.StubSapPo': { StubPoId: Generated<string>; PoNumber: string; IdempotencyKey: string; Reference: string; PayloadSha256: string; CreatedAt: Generated<Date> };
  'scm.StubSapFault': { FaultId: Generated<string>; Reference: string; Mode: 'reject' | 'timeout-before-create' | 'timeout-after-create' | 'lookup-unknown'; Remaining: Generated<number>; CreatedBy: number | null; CreatedAt: Generated<Date> };
  'scm.AwardItemSku': { AllocId: Generated<string>; AwardItemId: string; MaterialCode: string; Qty: string | number; SetStage: 'DEMAND' | 'RFQ' | 'PO'; IsActive: Generated<boolean>; ChangeReason: string | null; SetBy: number; SetAt: Generated<Date> };
  'scm.SalesAck': {
    AckId: Generated<string>; AwardBatchId: string; DemandId: string; Status: Generated<'PENDING' | 'ACKNOWLEDGED' | 'QUERY_RAISED' | 'ACKNOWLEDGED_LATE'>; Revision: Generated<number>;
    HandedOffWithoutAck: Generated<boolean>; RespondedBy: number | null; RespondedAt: Date | null; Comment: string | null; RowVer: Generated<Buffer>;
  };
  'scm.SalesAckHistory': {
    AckHistoryId: Generated<string>; AckId: string; Revision: number; FromStatus: string | null; ToStatus: string; Cause: string; AwardSnapshotJson: string | null;
    Comment: string | null; ActorUserId: number | null; ChangedAt: Generated<Date>;
  };
  'scm.MergeWeek': { MergeId: string; SourceWeekId: string; TargetWeekId: string; ContainersMoved: number };
  'scm.MergeItem': { MergeId: string; SourceSliceId: string; TargetSliceId: string; SourceLineId: string; TargetLineId: string; Qty: string | number };
  'scm.ContainerGroupItem': {
    ContainerGroupItemId: Generated<string>;
    ContainerGroupId: string;
    SpecMode: 'SPEC' | 'SKU';
    MajorCategory: string;
    SubMajorCategory: string;
    Size: string;
    MaterialClass: string;
    OriginCode: string;
    MaterialCode: string | null;
    Unit: string;
    ShareBp: number;
    ComputedQty: string | number;
    LineKey: Generated<string>;
  };
  'scm.QtySlice': {
    SliceId: Generated<string>;
    LineId: string;
    Qty: string | number;
    ExecState: Generated<SliceState>;
    BusinessOrigin: 'SALES' | 'PROCUREMENT' | 'CHANGE';
    ArrivedVia: Generated<'DIRECT' | 'MERGE'>;
    OriginDemandId: string;
    OriginLineId: string;
    ApprovedEtdWeek: string;
    EffectiveSubmittedAt: Date;
    SplitFromSliceId: string | null;
    MergedFromSliceId: string | null;
    MergedInBy: string | null;
    MergedOutBy: string | null;
    MergedToSliceId: string | null;
    CancelOrigin: 'SALES' | 'PROCUREMENT' | 'CHANGE' | null;
    CancelCrId: string | null;
    RfqLineId: string | null;
    AwardItemId: string | null;
    HandoffId: string | null;
  };
  'scm.SliceHistory': {
    HistoryId: Generated<string>;
    SliceId: string;
    Action: 'CREATE' | 'TRANSITION' | 'SPLIT';
    TriggerName: string | null;
    FromState: string | null;
    ToState: string;
    Qty: string | number;
    RelatedSliceId: string | null;
    ReasonCode: string | null;
    DocType: string | null;
    DocId: string | null;
    Comment: string | null;
    ActorUserId: number | null;
    ChangedAt: Generated<Date>;
  };
  'scm.DemandVersion': { DemandId: string; VersionNo: number; Reason: string; SourceRef: string | null; SnapshotJson: string; CreatedBy: number; CreatedAt: Generated<Date> };
  'scm.vLineLedger': {
    LineId: string; DemandId: string; DemandWeekId: string; EtdWeek: string; LineKey: string; Unit: string; RequestedQty: string; IsActive: boolean;
    OpenQty: string; InRfqQty: string; QuotedQty: string; AwardedQty: string; HandedOffQty: string; PoPrepQty: string;
    PoSubmittedQty: string; PoCreatedQty: string; CancelledQty: string; MergedOutQty: string; SliceTotal: string;
  };
  'scm.vDemandStatus': { DemandId: string; Status: string };
  'scm.ChangeRequest': {
    CrId: Generated<string>;
    CrNo: string;
    DemandId: string;
    CompanyCode: string;
    CrType: CrType;
    RaisedByDept: 'SALES' | 'PROCUREMENT';
    Status: CrStatus;
    ApplyStatus: Generated<'NOT_REQUIRED' | 'APPLIED' | 'PARTIALLY_APPLIED'>;
    ReasonCode: string;
    Comment: string;
    BlockedReason: string | null;
    RaisedBy: number;
    SubmittedAt: Generated<Date>;
    DecidedBy: number | null;
    DecidedAt: Date | null;
    DecisionComment: string | null;
    AppliedAt: Date | null;
    /** Spec 19: the RFQ a Procurement request was raised from. */
    RfqId: Generated<string | null>;
  };
  'scm.ChangeRequestItem': {
    CrItemId: Generated<string>;
    CrId: string;
    ItemNo: number;
    ItemKind: CrItemKind;
    EtdWeek: string;
    ContainerGroupId: string | null;
    LineId: string | null;
    BeforeJson: string | null;
    AfterJson: string | null;
    EffectJson: string;
    RequestedCount: number | null;
    RequestedQty: string | number | null;
    LedgerAtSubmit: string | null;
    Decision: 'APPROVE' | 'PARTIAL' | 'REJECT' | null;
    ApprovedCount: number | null;
    ApprovedQty: string | number | null;
    AppliedQty: string | number | null;
    ApplyMessage: string | null;
  };
  'scm.LineHold': { LineId: string; CrId: string; HeldAt: Generated<Date> };
  'scm.WeekHold': { DemandId: string; EtdWeek: string; CrId: string; HeldAt: Generated<Date> };
}

export type CrType = 'CHANGE_CONTAINERS' | 'CANCEL_WEEK' | 'CANCEL_DEMAND' | 'NOT_SOURCED' | 'ADD_TO_DEMAND' | 'WEEK_SHIFT' | 'MIX_CHANGE';
export type CrStatus = 'SUBMITTED' | 'APPROVED' | 'PARTIALLY_APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'BLOCKED';
export type CrItemKind = 'GROUP_COUNT' | 'GROUP_ADD' | 'GROUP_REMOVE' | 'GROUP_COMPOSITION' | 'QTY_NOT_SOURCED' | 'WEEK_CONTAINERS'
  | 'ADD_QTY' | 'ADD_CONTAINERS' | 'WEEK_SHIFT' | 'MIX_REDUCE' | 'MIX_ADD';
export type DemandWorkflowStatus = 'DRAFT' | 'SUBMITTED' | 'RETURNED' | 'ACCEPTED';
export type SliceState =
  | 'OPEN' | 'IN_RFQ' | 'QUOTED' | 'AWARDED' | 'HANDED_OFF'
  | 'PO_PREPARATION' | 'PO_SUBMITTED' | 'PO_CREATED' | 'CANCELLED' | 'MERGED_OUT';
