/**
 * Every permission name the API declares. One list, so roles can be built
 * from it later.
 */
export const PERMISSIONS = {
  systemHealth: 'system.health',
  masterdataView: 'masterdata.view',
  masterdataSync: 'masterdata.sync',
  settingsSapEdit: 'settings.sap.edit',
  appView: 'app.view',
  settingsUiEdit: 'settings.ui.edit',
} as const;

/** Rows-per-page choices for every table in the app. */
export const TABLE_PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_TABLE_PAGE_SIZE = 25;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Sortable columns of the Materials list. */
export const MATERIAL_SORT_FIELDS = ['MaterialCode', 'Description', 'MajorCategory', 'SubMajorCategory', 'Size'] as const;
export type MaterialSortField = (typeof MATERIAL_SORT_FIELDS)[number];
