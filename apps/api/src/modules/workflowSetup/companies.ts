/** Companies (spec 11): the data scope of the workflow. Never deleted, only deactivated. */
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import { DomainError } from '../workflow/errors.js';
import { rowVerHex, updateWithRowVer, withTx, type Db } from '../workflow/tx.js';

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const code = (max: number) => z.string().trim().max(max).regex(/^[A-Za-z0-9_-]*$/, 'Letters, digits, - and _ only');

export const companyInput = z.object({
  companyCode: code(10).min(1),
  name: z.string().trim().min(1).max(100),
  country: z.string().trim().regex(/^[A-Z]{2}$/, 'Two-letter country code'),
  timeZone: z.string().trim().refine(isTimeZone, 'Unknown time zone'),
  defaultPlant: code(10).min(1),
  purchasingOrg: code(10),
  purchasingGroup: code(10),
  isActive: z.boolean(),
  /** null = a new company. */
  rowVer: z.string().nullable(),
});
export type CompanyInput = z.infer<typeof companyInput>;

export async function listCompanies(db: Db) {
  const [rows, hints] = await Promise.all([
    db
      .selectFrom('scm.Company')
      .select(['CompanyCode', 'Name', 'Country', 'TimeZone', 'DefaultPlant', 'PurchasingOrg', 'PurchasingGroup', 'IsActive', rowVerHex().as('RowVer')])
      .orderBy('CompanyCode')
      .execute(),
    // Which purchasing organizations this company's synced POs use (a hint, spec 11).
    db
      .selectFrom('md.PurchaseOrder')
      .select(['CompanyCode', 'PurchasingOrg'])
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('PurchasingOrg', '<>', '')
      .groupBy(['CompanyCode', 'PurchasingOrg'])
      .execute(),
  ]);
  return rows.map((r) => ({
    ...r,
    orgHints: hints
      .filter((h) => h.CompanyCode === r.CompanyCode)
      .map((h) => ({ org: h.PurchasingOrg, orders: Number(h.n) }))
      .sort((a, b) => b.orders - a.orders),
  }));
}

export async function saveCompany(db: Db, c: CompanyInput): Promise<void> {
  await withTx(db, async (tx) => {
    const values = {
      Name: c.name, Country: c.country, TimeZone: c.timeZone, DefaultPlant: c.defaultPlant,
      PurchasingOrg: c.purchasingOrg, PurchasingGroup: c.purchasingGroup, IsActive: c.isActive,
    };
    if (c.rowVer === null) {
      const exists = await tx.selectFrom('scm.Company').select('CompanyCode').where('CompanyCode', '=', c.companyCode).executeTakeFirst();
      if (exists) throw new DomainError('DUPLICATE', `Company ${c.companyCode} already exists`, 409);
      await tx.insertInto('scm.Company').values({ CompanyCode: c.companyCode, ...values }).execute();
      return;
    }
    if (!c.isActive) {
      const open = await tx
        .selectFrom('scm.InboxItem')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('CompanyCode', '=', c.companyCode)
        .where(sql<SqlBool>`IsOpen = 1`)
        .executeTakeFirstOrThrow();
      if (Number(open.n) > 0) throw new DomainError('COMPANY_IN_USE', `Company ${c.companyCode} has ${open.n} open work item(s); it cannot be deactivated yet`);
    }
    await updateWithRowVer(tx, 'scm.Company', 'CompanyCode', c.companyCode, c.rowVer, sql`
      Name = ${values.Name}, Country = ${values.Country}, TimeZone = ${values.TimeZone}, DefaultPlant = ${values.DefaultPlant},
      PurchasingOrg = ${values.PurchasingOrg}, PurchasingGroup = ${values.PurchasingGroup}, IsActive = ${values.IsActive}`);
  });
}

/** Active companies for pickers (user drawer, My work filter). */
export async function companyOptions(db: Db) {
  return db.selectFrom('scm.Company').select(['CompanyCode', 'Name']).where('IsActive', '=', true).orderBy('CompanyCode').execute();
}

/** Replaces a user's companies (only active, existing companies). */
export async function setUserCompanies(db: Db, userId: number, companyCodes: string[]): Promise<void> {
  const codes = [...new Set(companyCodes)];
  await withTx(db, async (tx) => {
    const user = await tx.selectFrom('app.User').select('UserId').where('UserId', '=', userId).executeTakeFirst();
    if (!user) throw new DomainError('NOT_FOUND', 'User not found', 404);
    if (codes.length) {
      const found = await tx.selectFrom('scm.Company').select('CompanyCode').where('CompanyCode', 'in', codes).where('IsActive', '=', true).execute();
      if (found.length !== codes.length) throw new DomainError('BAD_COMPANY', 'Unknown or inactive company');
    }
    await tx.deleteFrom('scm.UserCompany').where('UserId', '=', userId).execute();
    if (codes.length) await tx.insertInto('scm.UserCompany').values(codes.map((CompanyCode) => ({ UserId: userId, CompanyCode }))).execute();
  });
}

