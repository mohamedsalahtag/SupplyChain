/** The regular sync of each SAP source — shared by its Sync button and the sync schedule, so both do exactly the same. */
import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { loadInclude } from '../../settings/materialsInclude.js';
import { runMaterialSync } from '../materials/materialSync.js';
import { loadPoInclude, runPoSync } from '../purchaseOrders/poSync.js';
import { loadSupplierInclude, runSupplierSync } from '../suppliers/supplierSync.js';
import type { Prepare } from './launch.js';
import type { SyncSource } from './syncRun.js';

export const SYNC_JOBS: Record<SyncSource, (db: Kysely<Database>) => Prepare> = {
  'sap.materials': (db) => async (conn) => {
    const { materialTypes } = await loadInclude(db);
    return (runId) => runMaterialSync(db, conn, materialTypes, runId);
  },
  'sap.suppliers': (db) => async (conn) => {
    const { groups } = await loadSupplierInclude(db);
    if (groups.length === 0) return 'Choose at least one supplier group and save it first.';
    return (runId) => runSupplierSync(db, conn, groups, runId);
  },
  // Changes since the watermark (the button's "Re-sync everything" / fresh copy stay manual).
  'sap.purchaseOrders': (db) => async (conn) => {
    const { orderTypes, startDate } = await loadPoInclude(db);
    if (orderTypes.length === 0 || !startDate) return 'Choose the order types and a start date, and save them first.';
    return (runId) => runPoSync(db, conn, { orderTypes, startDate }, runId, 'changes');
  },
};
