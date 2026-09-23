import { PERMISSIONS } from '@supplychain/shared';
import { z } from 'zod';
import { countRows } from '../sap/odata.js';
import { buildSapFilter } from '../modules/materials/sapMaterial.js';
import { includeSchema, loadAvailableTypes, loadInclude, refreshAvailableTypes, saveInclude } from './materialsInclude.js';
import { procedure, router } from '../trpc/trpc.js';
import { loadSapConnection, sapConnectionSchema, saveSapConnection } from './sapConnection.js';
import { appearanceSchema, brandingSchema, loadUi, saveAppearance, saveBranding } from './uiSettings.js';

const edit = procedure.meta({ permission: PERMISSIONS.settingsSapEdit });

/** Password may be left empty on save to keep the stored one. */
const saveInput = sapConnectionSchema.extend({ password: z.string() });

export const settingsRouter = router({
  /** Read by every screen (the app theme), so it only needs app.view. */
  getUi: procedure.meta({ permission: PERMISSIONS.appView }).query(({ ctx }) => loadUi(ctx.db)),

  saveAppearance: procedure
    .meta({ permission: PERMISSIONS.settingsUiEdit })
    .input(appearanceSchema)
    .mutation(async ({ ctx, input }) => {
      await saveAppearance(ctx.db, input);
      ctx.log.info({ user: ctx.user.name, ...input }, 'Appearance saved');
      return { saved: true };
    }),

  saveBranding: procedure
    .meta({ permission: PERMISSIONS.settingsUiEdit })
    .input(brandingSchema)
    .mutation(async ({ ctx, input }) => {
      await saveBranding(ctx.db, input);
      ctx.log.info({ user: ctx.user.name, siteName: input.siteName, customIcon: !!input.iconDataUrl }, 'Branding saved');
      return { saved: true };
    }),

  getSap: edit.query(async ({ ctx }) => {
    const conn = await loadSapConnection(ctx.db, ctx.encKey);
    if (!conn) return null;
    const { password, ...rest } = conn; // the password never leaves the server
    return { ...rest, hasPassword: password.length > 0 };
  }),

  saveSap: edit.input(saveInput).mutation(async ({ ctx, input }) => {
    let password = input.password;
    if (!password) {
      const existing = await loadSapConnection(ctx.db, ctx.encKey);
      if (!existing) throw new Error('Enter the password');
      password = existing.password;
    }
    await saveSapConnection(ctx.db, ctx.encKey, { ...input, password });
    ctx.log.info({ user: ctx.user.name }, 'SAP connection saved');
    return { saved: true };
  }),

  /** Uses the saved settings, never unsaved form values. */
  testSap: edit.mutation(async ({ ctx }) => {
    const conn = await loadSapConnection(ctx.db, ctx.encKey);
    if (!conn) return { ok: false as const, message: 'No connection saved yet. Fill in the form and click Save first.' };
    const started = Date.now();
    try {
      const { materialTypes } = await loadInclude(ctx.db);
      const count = await countRows(conn, buildSapFilter(materialTypes));
      return { ok: true as const, ms: Date.now() - started, count, materialTypes };
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) };
    }
  }),

  /** Chosen material types and the list SAP offers (from the last check). */
  getMaterialsInclude: edit.query(async ({ ctx }) => {
    const [include, available] = await Promise.all([loadInclude(ctx.db), loadAvailableTypes(ctx.db)]);
    return { ...include, available };
  }),

  saveMaterialsInclude: edit.input(includeSchema).mutation(async ({ ctx, input }) => {
    await saveInclude(ctx.db, input);
    ctx.log.info({ user: ctx.user.name, ...input }, 'Material types for sync saved');
    return { saved: true };
  }),

  /** Reads the material types SAP has right now (a few seconds) and keeps the list. */
  refreshMaterialTypes: edit.mutation(async ({ ctx }) => {
    const conn = await loadSapConnection(ctx.db, ctx.encKey);
    if (!conn) throw new Error('No SAP connection saved yet (SAP connection tab).');
    return refreshAvailableTypes(ctx.db, conn);
  }),
});
