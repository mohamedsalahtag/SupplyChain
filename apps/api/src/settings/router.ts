import { TRPCError } from '@trpc/server';
import { P } from '@supplychain/shared';
import { z } from 'zod';
import { countRows, entityPath } from '../sap/odata.js';
import { buildSapFilter } from '../modules/materials/sapMaterial.js';
import { includeSchema, loadAvailableTypes, loadInclude, refreshAvailableTypes, saveInclude } from './materialsInclude.js';
import { procedure, publicProcedure, router } from '../trpc/trpc.js';
import { loadSapConnection, sapConnectionSchema, saveSapConnection } from './sapConnection.js';
import { appearanceSchema, brandingSchema, loadUi, saveAppearance, saveBranding } from './uiSettings.js';
import { loadSapPoApi, saveSapPoApi, sapPoApiProblems, sapPoApiSchema } from './sapPoApi.js';
import { httpSapAdapter } from '../modules/po/sapHttpAdapter.js';
import { OUTBOX } from '../modules/po/outbox.js';
import { audit } from '../auth/audit.js';

const edit = procedure.meta({ permission: P.configSapEdit });
const configOpen = procedure.meta({ permission: P.configOpen });
const typesEdit = procedure.meta({ permission: P.configSyncTypesEdit });

/** Password may be left empty on save to keep the stored one. */
const saveInput = sapConnectionSchema.extend({ password: z.string() });

export const settingsRouter = router({
  /** Site name, icon and font size: needed by every screen and by the sign-in page, so public. */
  getUi: publicProcedure.query(({ ctx }) => loadUi(ctx.db)),

  saveAppearance: procedure
    .meta({ permission: P.configAppearanceEdit })
    .input(appearanceSchema)
    .mutation(async ({ ctx, input }) => {
      await saveAppearance(ctx.db, input);
      ctx.log.info({ user: ctx.user.displayName, ...input }, 'Appearance saved');
      return { saved: true };
    }),

  saveBranding: procedure
    .meta({ permission: P.configGeneralEdit })
    .input(brandingSchema)
    .mutation(async ({ ctx, input }) => {
      await saveBranding(ctx.db, input);
      ctx.log.info({ user: ctx.user.displayName, siteName: input.siteName, customIcon: !!input.iconDataUrl }, 'Branding saved');
      return { saved: true };
    }),

  getSap: configOpen.query(async ({ ctx }) => {
    const conn = await loadSapConnection(ctx.db, ctx.encKey);
    if (!conn) return null;
    const { password, ...rest } = conn; // the password never leaves the server
    return { ...rest, hasPassword: password.length > 0 };
  }),

  saveSap: edit.input(saveInput).mutation(async ({ ctx, input }) => {
    let password = input.password;
    if (!password) {
      const existing = await loadSapConnection(ctx.db, ctx.encKey);
      if (!existing) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enter the password' });
      // The saved password is only reused for the same SAP address and user: it is never sent to a new host.
      if (existing.baseUrl !== input.baseUrl || existing.user !== input.user) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'The SAP address or user changed: enter the password again.' });
      }
      password = existing.password;
    }
    await saveSapConnection(ctx.db, ctx.encKey, { ...input, password });
    ctx.log.info({ user: ctx.user.displayName }, 'SAP connection saved');
    return { saved: true };
  }),

  /** Configuration → SAP purchase orders: where the PO outbox sends (simulator or the company's PO API). Password never leaves. */
  getSapPo: edit.query(async ({ ctx }) => {
    const { password, ...rest } = await loadSapPoApi(ctx.db, ctx.encKey);
    return { ...rest, hasPassword: password.length > 0, problems: sapPoApiProblems({ ...rest, password }), leaseMinutes: OUTBOX.leaseMinutes };
  }),

  /** An empty password keeps the saved one — only for the same address and user. */
  saveSapPo: edit.input(sapPoApiSchema).mutation(async ({ ctx, input }) => {
    const current = await loadSapPoApi(ctx.db, ctx.encKey);
    if (!input.password && current.password && (input.baseUrl !== current.baseUrl || input.user !== current.user)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'The address or user changed: enter the password again.' });
    }
    if (input.timeoutSeconds * 1000 >= OUTBOX.leaseMinutes * 60_000) throw new TRPCError({ code: 'BAD_REQUEST', message: `The timeout must stay below ${OUTBOX.leaseMinutes} minutes.` });
    await saveSapPoApi(ctx.db, ctx.encKey, { ...input, password: input.password || current.password });
    await audit(ctx.db, { userId: ctx.user.id, action: 'config.sapPo.save', details: { mode: input.mode, baseUrl: input.baseUrl, createPath: input.createPath, lookupPath: input.lookupPath, user: input.user } }, ctx.log);
    return { saved: true };
  }),

  /** Asks the saved API for a reference that cannot exist: "not found" (or found) proves the address, login and lookup work. Creates nothing. */
  testSapPo: edit.mutation(async ({ ctx }) => {
    const c = await loadSapPoApi(ctx.db, ctx.encKey);
    if (c.mode !== 'api') return { ok: false as const, message: 'Mode is the simulator — nothing to test.' };
    const missing = sapPoApiProblems(c);
    if (missing.length) return { ok: false as const, message: `Missing: ${missing.join(', ')}` };
    const t0 = Date.now();
    const r = await httpSapAdapter(c).findPoByReference('POD-TEST-000000');
    return r.kind === 'UNKNOWN'
      ? { ok: false as const, message: r.detail }
      : { ok: true as const, message: `Lookup answered in ${Date.now() - t0} ms (${r.kind === 'FOUND' ? 'found a PO' : 'no PO for the test reference, as expected'}).` };
  }),

  /** Uses the saved settings, never unsaved form values. */
  testSap: edit.mutation(async ({ ctx }) => {
    const conn = await loadSapConnection(ctx.db, ctx.encKey);
    if (!conn) return { ok: false as const, message: 'No connection saved yet. Fill in the form and click Save first.' };
    // Each service is tested on its own, so one broken path doesn't hide the others.
    const timed = async (name: string, run: () => Promise<number>) => {
      const t0 = Date.now();
      try {
        const count = await run();
        return { name, ok: true as const, ms: Date.now() - t0, count };
      } catch (err) {
        return { name, ok: false as const, message: err instanceof Error ? err.message : String(err) };
      }
    };
    const { materialTypes } = await loadInclude(ctx.db);
    const services = await Promise.all([
      timed(`Materials (types ${materialTypes.join(', ')})`, () =>
        countRows(conn, { path: conn.materialsPath, version: 'v2' }, buildSapFilter(materialTypes)),
      ),
      timed('Suppliers (all groups)', () => countRows(conn, { path: entityPath(conn.suppliersPath, 'A_Supplier'), version: 'v2' })),
      timed('Purchase orders (all types)', () =>
        countRows(conn, { path: entityPath(conn.purchaseOrdersPath, 'PurchaseOrder'), version: 'v4' }),
      ),
    ]);
    return { ok: services.every((s) => s.ok), services };
  }),

  /** Chosen material types and the list SAP offers (from the last check). */
  getMaterialsInclude: configOpen.query(async ({ ctx }) => {
    const [include, available] = await Promise.all([loadInclude(ctx.db), loadAvailableTypes(ctx.db)]);
    return { ...include, available };
  }),

  saveMaterialsInclude: typesEdit.input(includeSchema).mutation(async ({ ctx, input }) => {
    await saveInclude(ctx.db, input);
    ctx.log.info({ user: ctx.user.displayName, ...input }, 'Material types for sync saved');
    return { saved: true };
  }),

  /** Reads the material types SAP has right now (a few seconds) and keeps the list. */
  refreshMaterialTypes: typesEdit.mutation(async ({ ctx }) => {
    const conn = await loadSapConnection(ctx.db, ctx.encKey);
    if (!conn) throw new Error('No SAP connection saved yet (SAP connection tab).');
    return refreshAvailableTypes(ctx.db, conn);
  }),
});
