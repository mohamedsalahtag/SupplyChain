export * from './permissions.js';
export * from './rfq.js';

/** Rows-per-page choices for every table in the app. */
export const TABLE_PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_TABLE_PAGE_SIZE = 25;

/** Sortable columns of the Materials list. */
export const MATERIAL_SORT_FIELDS = ['MaterialCode', 'Description', 'MajorCategory', 'SubMajorCategory', 'Size'] as const;
export type MaterialSortField = (typeof MATERIAL_SORT_FIELDS)[number];
