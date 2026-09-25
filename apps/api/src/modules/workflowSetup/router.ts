/** Workflow setup (spec 11): companies, reason codes, origin map, workflow settings. Every save is audited. */
import { P, SIGNED_IN } from '@supplychain/shared';
import { z } from 'zod';
import { audit } from '../../auth/audit.js';
import { procedure, router } from '../../trpc/trpc.js';
import { ITEM_TYPES } from '../workflow/inbox.js';
import { countryOptions, listOrigins, setOrigin } from '../workflow/origins.js';
import { loadWfSettings, saveWfSettings, wfSettingsSchema, wfSettingsVersion } from '../workflow/settings.js';
import { addManualOrigin, listSupplierOrigins, removeManualOrigin } from '../workflow/supplierOrigins.js';
import { companyInput, companyOptions, listCompanies, saveCompany } from './companies.js';
import { listReasons, REASON_CONTEXTS, reasonInput, saveReason } from './reasons.js';

const view = procedure.meta({ permission: P.configOpen });

export const workflowSetupRouter = router({
  companies: view.query(({ ctx }) => listCompanies(ctx.db)),
  saveCompany: procedure
    .meta({ permission: P.configWfCompaniesEdit })
    .input(companyInput)
    .mutation(async ({ ctx, input }) => {
      await saveCompany(ctx.db, input);
      await audit(ctx.db, { userId: ctx.user.id, action: 'config.workflow.company', target: input.companyCode, details: input }, ctx.log);
      return { saved: true };
    }),
  /** Active companies for pickers; not sensitive, so any signed-in user may read them. */
  companyOptions: procedure.meta({ permission: SIGNED_IN }).query(({ ctx }) => companyOptions(ctx.db)),

  reasons: view.query(async ({ ctx }) => ({ rows: await listReasons(ctx.db), contexts: REASON_CONTEXTS })),
  saveReason: procedure
    .meta({ permission: P.configWfReasonsEdit })
    .input(reasonInput)
    .mutation(async ({ ctx, input }) => {
      await saveReason(ctx.db, input);
      await audit(ctx.db, { userId: ctx.user.id, action: 'config.workflow.reason', target: input.reasonCode, details: input }, ctx.log);
      return { saved: true };
    }),

  origins: view.input(z.object({ unmatchedOnly: z.boolean().default(false) })).query(({ ctx, input }) => listOrigins(ctx.db, input.unmatchedOnly)),
  countries: view.query(() => countryOptions()),
  setOrigin: procedure
    .meta({ permission: P.configWfOriginsEdit })
    .input(z.object({ originName: z.string().max(80), countryCode: z.string().regex(/^[A-Z]{2}$/).nullable(), rowVer: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await setOrigin(ctx.db, input.originName, input.countryCode, input.rowVer);
      await audit(ctx.db, { userId: ctx.user.id, action: 'config.workflow.origin', target: input.originName, details: { countryCode: input.countryCode } }, ctx.log);
      return { saved: true };
    }),

  /** Spec 18: origins a supplier can supply (SAP country, PO history, added by hand). */
  supplierOrigins: view.input(z.object({ q: z.string().trim().max(60).optional(), origin: z.string().regex(/^[A-Z]{2}$/).optional(), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(10).max(100).default(25) }))
    .query(({ ctx, input }) => listSupplierOrigins(ctx.db, input.q, input.origin, input.page, input.pageSize)),
  setSupplierOrigin: procedure
    .meta({ permission: P.supplierOriginsEdit })
    .input(z.object({ supplierCode: z.string().trim().min(1).max(20), originCode: z.string().regex(/^[A-Z]{2}$/), add: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.add) await addManualOrigin(ctx.db, input.supplierCode, input.originCode, ctx.user.id);
      else await removeManualOrigin(ctx.db, input.supplierCode, input.originCode);
      await audit(ctx.db, { userId: ctx.user.id, action: 'config.workflow.supplierOrigin', target: input.supplierCode, details: input }, ctx.log);
      return { saved: true };
    }),

  settings: view.query(async ({ ctx }) => ({
    settings: await loadWfSettings(ctx.db),
    version: await wfSettingsVersion(ctx.db),
    itemTypes: Object.entries(ITEM_TYPES).map(([key, t]) => ({ key, label: t.label, category: t.category })),
  })),
  saveSettings: procedure
    .meta({ permission: P.configWfSettingsEdit })
    .input(z.object({ settings: wfSettingsSchema, version: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await saveWfSettings(ctx.db, input.settings, input.version);
      await audit(ctx.db, { userId: ctx.user.id, action: 'config.workflow.settings', details: input.settings }, ctx.log);
      return { saved: true };
    }),
});
