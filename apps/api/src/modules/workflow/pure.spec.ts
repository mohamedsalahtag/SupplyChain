/** Unit tests for the small pure parts of the workflow foundation (Stage 0). */
import { describe, expect, it } from 'vitest';
import { assertCan, type Actor } from './access.js';
import { contentTypeFor } from './attachments.js';
import { DomainError, toTrpcError } from './errors.js';
import { staleSources } from './masterData.js';
import { countryName, matchCountryCode, normalizeName } from './origins.js';

describe('origin names → country codes (spec 11)', () => {
  it('matches SAP names by English country name', () => {
    expect(matchCountryCode('Ecuador')).toBe('EC');
    expect(matchCountryCode('South Africa')).toBe('ZA');
    expect(matchCountryCode('United Arab Emirates')).toBe('AE');
    expect(matchCountryCode('chile')).toBe('CL');
    // Deprecated codes that share a name are never chosen (FX = Metropolitan France, UK, SU, YU…).
    expect(matchCountryCode('France')).toBe('FR');
    expect(matchCountryCode('United Kingdom')).toBe('GB');
    expect(matchCountryCode('Russia')).toBe('RU');
  });
  it('treats "and" and "&" alike, and ignores accents', () => {
    expect(matchCountryCode('Bosnia and Herzegovina')).toBe('BA');
    expect(normalizeName('Côte d’Ivoire')).toBe("cote d'ivoire");
  });
  it('leaves names that are not exact country names unmatched', () => {
    expect(matchCountryCode('USA')).toBeNull();
    expect(matchCountryCode('Gulf')).toBeNull();
    expect(matchCountryCode('')).toBeNull();
  });
  it('names a code for display', () => {
    expect(countryName('EC')).toBe('Ecuador');
    expect(countryName(null)).toBe('');
  });
});

describe('assertCan: permission and company (plan v5 §2)', () => {
  const actor = (over: Partial<Actor>): Actor => ({ id: 1, isAdmin: false, permissions: new Set(), companies: new Set(), ...over });
  const cases: [string, Actor, boolean][] = [
    ['permission + company', actor({ permissions: new Set(['demand.accept']), companies: new Set(['1000']) }), true],
    ['permission, other company', actor({ permissions: new Set(['demand.accept']), companies: new Set(['2000']) }), false],
    ['company, no permission', actor({ permissions: new Set(['demand.submit']), companies: new Set(['1000']) }), false],
    ['admin with the company', actor({ isAdmin: true, companies: new Set(['1000']) }), true],
    ['admin without the company', actor({ isAdmin: true, companies: new Set() }), false],
  ];
  it.each(cases)('%s', (_name, a, ok) => {
    const call = () => assertCan(a, 'demand.accept', '1000');
    if (ok) expect(call).not.toThrow();
    else expect(call).toThrow(/Not allowed/);
  });
});

describe('master data freshness', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  const h = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  it('lists sources never synced or older than the limit', () => {
    expect(staleSources({ 'sap.materials': h(1), 'sap.suppliers': h(30), 'sap.purchaseOrders': null }, 26, now)).toEqual(['sap.suppliers', 'sap.purchaseOrders']);
    expect(staleSources({ 'sap.materials': h(1), 'sap.suppliers': h(25), 'sap.purchaseOrders': h(2) }, 26, now)).toEqual([]);
  });
});

describe('attachment types', () => {
  it('allows documents, images, spreadsheets and emails', () => {
    expect(contentTypeFor('quote.PDF')).toBe('application/pdf');
    expect(contentTypeFor('mail.msg')).toBe('application/vnd.ms-outlook');
  });
  it('refuses anything else', () => {
    expect(() => contentTypeFor('run.exe')).toThrow(/not allowed/);
    expect(() => contentTypeFor('noextension')).toThrow(/not allowed/);
  });
});

describe('domain errors → tRPC codes', () => {
  it('maps status to code and keeps the cause', () => {
    const e = toTrpcError(new DomainError('STALE_WRITE', 'changed', 409));
    expect(e.code).toBe('CONFLICT');
    expect(e.cause).toBeInstanceOf(DomainError);
    expect(toTrpcError(new DomainError('X', 'y')).code).toBe('UNPROCESSABLE_CONTENT');
    expect(toTrpcError(new DomainError('NOT_FOUND', 'y', 404)).code).toBe('NOT_FOUND');
  });
});
