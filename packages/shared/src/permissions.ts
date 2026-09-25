/**
 * Every screen and button in the app that can be granted to a role. The
 * Security page shows exactly this list. When you add a screen or a button,
 * add it here — a unit test fails if an API procedure uses a key missing here.
 */
export type CatalogAction = { key: string; label: string };
export type CatalogScreen = {
  key: string;
  label: string;
  section: string;
  /** Permission to see the screen in the menu and open it. */
  open: string;
  actions: CatalogAction[];
};

export const PERMISSION_CATALOG: CatalogScreen[] = [
  { key: 'work', label: 'My work', section: 'General', open: 'work.open', actions: [] },
  { key: 'materials', label: 'Materials', section: 'Master data', open: 'materials.open', actions: [] },
  { key: 'suppliers', label: 'Suppliers', section: 'Master data', open: 'suppliers.open', actions: [] },
  {
    key: 'demands',
    label: 'Demands',
    section: 'Purchasing',
    open: 'demands.open',
    actions: [
      { key: 'demand.create', label: 'Create and edit draft demands' },
      { key: 'demand.submit', label: 'Submit demands to Procurement' },
      { key: 'demand.accept', label: 'Accept submitted demands' },
      { key: 'demand.return', label: 'Return submitted demands to Sales' },
      { key: 'demand.comment', label: 'Comment on demands' },
      { key: 'demand.attach', label: 'Upload attachments to demands' },
      { key: 'demand.merge', label: 'Merge accepted demands (Procurement)' },
      { key: 'demand.unmerge', label: 'Undo a merge (Procurement)' },
    ],
  },
  {
    key: 'crs',
    label: 'Change requests',
    section: 'Purchasing',
    open: 'crs.open',
    actions: [
      { key: 'cr.raise.sales', label: 'Request container changes on accepted demands (Sales)' },
      { key: 'cr.raise.procurement', label: 'Request "not sourced" on accepted demands (Procurement)' },
      { key: 'cr.decide.sales', label: 'Decide change requests raised by Sales' },
      { key: 'cr.decide.procurement', label: 'Decide change requests raised by Procurement' },
      { key: 'cr.withdraw', label: 'Withdraw own change requests' },
    ],
  },
  {
    key: 'rfqs',
    label: 'RFQs',
    section: 'Purchasing',
    open: 'rfqs.open',
    actions: [{ key: 'rfq.manage', label: 'Create, send, record quotes, release and cancel RFQs' }],
  },
  {
    key: 'awards',
    label: 'Awards',
    section: 'Purchasing',
    open: 'awards.open',
    actions: [
      { key: 'award.manage', label: 'Award quantities, un-award, correct SKUs, edit shipments (Procurement)' },
      { key: 'ack.respond', label: 'Acknowledge awards or raise a query (Sales)' },
    ],
  },
  {
    key: 'handoffs',
    label: 'Handoffs',
    section: 'Purchasing',
    open: 'handoffs.open',
    actions: [
      { key: 'handoff.send', label: 'Complete shipping terms and hand off a supplier’s award (Procurement)' },
      { key: 'handoff.accept', label: 'Accept handoffs (PO team)' },
      { key: 'handoff.return', label: 'Return handoffs to Procurement (PO team)' },
    ],
  },
  {
    key: 'po',
    label: 'PO drafts & SAP',
    section: 'Purchasing',
    open: 'po.open',
    actions: [{ key: 'po.manage', label: 'Select SKUs, build, validate and submit PO drafts, resolve SAP outcomes (PO team)' }],
  },
  { key: 'purchaseOrders', label: 'Purchase orders', section: 'Purchasing', open: 'purchaseOrders.open', actions: [] },
  { key: 'reports', label: 'Reports', section: 'Purchasing', open: 'reports.open', actions: [] },
  {
    key: 'users',
    label: 'Users',
    section: 'Administration',
    open: 'users.open',
    actions: [
      { key: 'users.add', label: 'Add a user from Active Directory' },
      { key: 'users.companies.edit', label: 'Choose which companies a user works for' },
      { key: 'users.edit', label: 'Change a user’s roles or active status' },
    ],
  },
  {
    key: 'security',
    label: 'Security',
    section: 'Administration',
    open: 'security.open',
    actions: [{ key: 'security.roles.edit', label: 'Create and edit roles and their permissions' }],
  },
  { key: 'operations', label: 'Operations status', section: 'Administration', open: 'operations.open', actions: [] },
  {
    key: 'configuration',
    label: 'Configuration',
    section: 'Administration',
    open: 'configuration.open',
    actions: [
      { key: 'configuration.general.edit', label: 'Change site name and icon' },
      { key: 'configuration.appearance.edit', label: 'Change font size' },
      { key: 'configuration.sap.edit', label: 'Change and test the SAP connection' },
      { key: 'configuration.sync.types.edit', label: 'Choose material types to copy' },
      { key: 'configuration.sync.run', label: 'Run the materials sync' },
      { key: 'configuration.suppliers.edit', label: 'Choose supplier groups to copy' },
      { key: 'configuration.suppliers.run', label: 'Run the suppliers sync' },
      { key: 'configuration.suppliers.fresh', label: 'Delete all suppliers and sync a fresh copy' },
      { key: 'configuration.po.edit', label: 'Choose purchase order types and start date' },
      { key: 'configuration.po.run', label: 'Run the purchase orders sync' },
      { key: 'configuration.po.fresh', label: 'Delete all purchase orders and sync a fresh copy' },
      { key: 'configuration.workflow.companies.edit', label: 'Add and change companies' },
      { key: 'configuration.workflow.reasons.edit', label: 'Add and change reason codes' },
      { key: 'configuration.workflow.origins.edit', label: 'Map SAP origins to countries' },
      { key: 'configuration.workflow.supplierOrigins.edit', label: 'Add or remove origins a supplier can supply' },
      { key: 'configuration.workflow.settings.edit', label: 'Change workflow settings (due times, limits)' },
      { key: 'configuration.shipping.edit', label: 'Keep the shipping-term lists (Incoterms, ports, payment-term descriptions)' },
      { key: 'configuration.ad.edit', label: 'Change and test the Active Directory connection' },
    ],
  },
];

/** All grantable keys, in catalogue order. */
export const ALL_PERMISSION_KEYS: string[] = PERMISSION_CATALOG.flatMap((s) => [s.open, ...s.actions.map((a) => a.key)]);

/** Named keys for code, so a typo is a compile error. */
export const P = {
  workOpen: 'work.open',
  materialsOpen: 'materials.open',
  suppliersOpen: 'suppliers.open',
  demandsOpen: 'demands.open',
  demandCreate: 'demand.create',
  demandSubmit: 'demand.submit',
  demandAccept: 'demand.accept',
  demandReturn: 'demand.return',
  demandComment: 'demand.comment',
  demandAttach: 'demand.attach',
  demandMerge: 'demand.merge',
  demandUnmerge: 'demand.unmerge',
  crsOpen: 'crs.open',
  crRaiseSales: 'cr.raise.sales',
  crRaiseProcurement: 'cr.raise.procurement',
  crDecideSales: 'cr.decide.sales',
  crDecideProcurement: 'cr.decide.procurement',
  crWithdraw: 'cr.withdraw',
  purchaseOrdersOpen: 'purchaseOrders.open',
  rfqsOpen: 'rfqs.open',
  rfqManage: 'rfq.manage',
  awardsOpen: 'awards.open',
  awardManage: 'award.manage',
  ackRespond: 'ack.respond',
  handoffsOpen: 'handoffs.open',
  handoffSend: 'handoff.send',
  handoffAccept: 'handoff.accept',
  handoffReturn: 'handoff.return',
  poOpen: 'po.open',
  poManage: 'po.manage',
  reportsOpen: 'reports.open',
  supplierOriginsEdit: 'configuration.workflow.supplierOrigins.edit',
  usersOpen: 'users.open',
  usersAdd: 'users.add',
  usersEdit: 'users.edit',
  usersCompaniesEdit: 'users.companies.edit',
  securityOpen: 'security.open',
  securityRolesEdit: 'security.roles.edit',
  operationsOpen: 'operations.open',
  configOpen: 'configuration.open',
  configGeneralEdit: 'configuration.general.edit',
  configAppearanceEdit: 'configuration.appearance.edit',
  configSapEdit: 'configuration.sap.edit',
  configSyncTypesEdit: 'configuration.sync.types.edit',
  configSyncRun: 'configuration.sync.run',
  configSuppliersEdit: 'configuration.suppliers.edit',
  configSuppliersRun: 'configuration.suppliers.run',
  configSuppliersFresh: 'configuration.suppliers.fresh',
  configPoEdit: 'configuration.po.edit',
  configPoRun: 'configuration.po.run',
  configPoFresh: 'configuration.po.fresh',
  configWfCompaniesEdit: 'configuration.workflow.companies.edit',
  configWfReasonsEdit: 'configuration.workflow.reasons.edit',
  configWfOriginsEdit: 'configuration.workflow.origins.edit',
  configWfSettingsEdit: 'configuration.workflow.settings.edit',
  configShippingEdit: 'configuration.shipping.edit',
  configAdEdit: 'configuration.ad.edit',
} as const;

/**
 * Not grantable: anything a signed-in user needs just to use the app
 * (theme, own table preferences, own profile).
 */
export const SIGNED_IN = 'signed-in';
