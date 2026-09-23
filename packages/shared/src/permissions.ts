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
  { key: 'home', label: 'Home', section: 'General', open: 'home.open', actions: [] },
  { key: 'materials', label: 'Materials', section: 'Master data', open: 'materials.open', actions: [] },
  {
    key: 'users',
    label: 'Users',
    section: 'Administration',
    open: 'users.open',
    actions: [
      { key: 'users.add', label: 'Add a user from Active Directory' },
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
      { key: 'configuration.ad.edit', label: 'Change and test the Active Directory connection' },
    ],
  },
];

/** All grantable keys, in catalogue order. */
export const ALL_PERMISSION_KEYS: string[] = PERMISSION_CATALOG.flatMap((s) => [s.open, ...s.actions.map((a) => a.key)]);

/** Named keys for code, so a typo is a compile error. */
export const P = {
  homeOpen: 'home.open',
  materialsOpen: 'materials.open',
  usersOpen: 'users.open',
  usersAdd: 'users.add',
  usersEdit: 'users.edit',
  securityOpen: 'security.open',
  securityRolesEdit: 'security.roles.edit',
  configOpen: 'configuration.open',
  configGeneralEdit: 'configuration.general.edit',
  configAppearanceEdit: 'configuration.appearance.edit',
  configSapEdit: 'configuration.sap.edit',
  configSyncTypesEdit: 'configuration.sync.types.edit',
  configSyncRun: 'configuration.sync.run',
  configAdEdit: 'configuration.ad.edit',
} as const;

/**
 * Not grantable: anything a signed-in user needs just to use the app
 * (theme, own table preferences, own profile).
 */
export const SIGNED_IN = 'signed-in';
