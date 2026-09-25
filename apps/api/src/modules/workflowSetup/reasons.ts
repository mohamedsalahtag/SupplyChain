/** Reason codes (spec 11). Deactivated, never deleted, so history keeps its meaning. */
import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '../workflow/errors.js';
import { rowVerHex, updateWithRowVer, withTx, type Db } from '../workflow/tx.js';

export const REASON_CONTEXTS = ['CR_SALES', 'CR_PROC', 'RELEASE', 'RFQ_CANCEL', 'UNAWARD', 'HANDOFF_RETURN', 'SKU_CHANGE', 'PROCEED_NO_ACK', 'HANDOFF_AUTO'] as const;

export const reasonInput = z.object({
  reasonCode: z.string().trim().min(1).max(40).regex(/^[A-Z0-9_]+$/, 'Capital letters, digits and _ only'),
  context: z.enum(REASON_CONTEXTS),
  description: z.string().trim().min(1).max(200),
  countsAgainstProcurement: z.boolean(),
  isActive: z.boolean(),
  /** null = a new code. */
  rowVer: z.string().nullable(),
});
export type ReasonInput = z.infer<typeof reasonInput>;

export async function listReasons(db: Db) {
  return db
    .selectFrom('scm.ReasonCode')
    .select(['ReasonCode', 'Context', 'Description', 'CountsAgainstProcurement', 'IsActive', rowVerHex().as('RowVer')])
    .orderBy('Context')
    .orderBy('ReasonCode')
    .execute();
}

export async function saveReason(db: Db, r: ReasonInput): Promise<void> {
  await withTx(db, async (tx) => {
    if (r.rowVer === null) {
      const exists = await tx.selectFrom('scm.ReasonCode').select('ReasonCode').where('ReasonCode', '=', r.reasonCode).executeTakeFirst();
      if (exists) throw new DomainError('DUPLICATE', `Reason code ${r.reasonCode} already exists`, 409);
      await tx
        .insertInto('scm.ReasonCode')
        .values({ ReasonCode: r.reasonCode, Context: r.context, Description: r.description, CountsAgainstProcurement: r.countsAgainstProcurement, IsActive: r.isActive })
        .execute();
      return;
    }
    // The code and its context identify the reason in history: only the text and flags change.
    await updateWithRowVer(tx, 'scm.ReasonCode', 'ReasonCode', r.reasonCode, r.rowVer, sql`
      Description = ${r.description}, CountsAgainstProcurement = ${r.countsAgainstProcurement}, IsActive = ${r.isActive}`);
  });
}
