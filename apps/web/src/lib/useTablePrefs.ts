import { useRef } from 'react';
import { DEFAULT_TABLE_PAGE_SIZE, TABLE_PAGE_SIZES } from '@supplychain/shared';
import { trpc } from './trpc';

/** antd `pageSizeOptions` for every table: 25 / 50 / 100. */
export const PAGE_SIZE_OPTIONS = TABLE_PAGE_SIZES.map(String);

export type TablePrefs = ReturnType<typeof useTablePrefs>;

/** antd `pagination` for a plain Table whose rows are all loaded: the rows-per-page choice is saved like AppTable's. */
export const savedPagination = (prefs: TablePrefs) => ({
  pageSize: prefs.pageSize, pageSizeOptions: PAGE_SIZE_OPTIONS, showSizeChanger: true, size: 'small' as const,
  onChange: (_page: number, size: number) => { if (size !== prefs.pageSize) prefs.setPageSize(size); },
});
/** hiddenColumns null = the user never chose; the table's defaults apply. */
type Prefs = { pageSize: number; hiddenColumns: string[] | null };

/**
 * Rows per page and hidden columns for one table, saved per user in the
 * database. They survive restarts and change only when the user changes them.
 * `defaultHidden` are the columns hidden until the user picks their own.
 */
export function useTablePrefs(table: string, defaultHidden: string[] = []) {
  const utils = trpc.useUtils();
  const query = trpc.prefs.getTable.useQuery({ table }, { staleTime: Infinity });
  // Saves run strictly one after another, so the last click is the last write.
  // (React Query's mutation `scope` queue was tried: a queued save was never sent.)
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  const pageSize = query.data?.pageSize ?? DEFAULT_TABLE_PAGE_SIZE;
  const savedHidden = query.data?.hiddenColumns ?? null;
  const hiddenColumns = savedHidden ?? defaultHidden;

  /** Show the change at once, then save the complete preferences. */
  const apply = (next: Prefs) => {
    utils.prefs.getTable.setData({ table }, next);
    saving.current = saving.current
      .then(() => utils.client.prefs.setTable.mutate({ table, ...next }))
      .catch(() => utils.prefs.getTable.invalidate({ table })); // on failure, show what the server really has
  };

  return {
    table,
    /** False until the saved preferences have loaded — don't fetch rows before that. */
    ready: !query.isPending,
    pageSize,
    hiddenColumns,
    /** True when the user's columns differ from the table's defaults. */
    customColumns: savedHidden !== null,
    setPageSize: (n: number) => apply({ pageSize: n, hiddenColumns: savedHidden }),
    setHiddenColumns: (cols: string[]) => apply({ pageSize, hiddenColumns: cols }),
    resetColumns: () => apply({ pageSize, hiddenColumns: null }),
  };
}
