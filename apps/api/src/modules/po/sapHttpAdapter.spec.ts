import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveSapPoApi, sapPoApiSchema, sapPoApiProblems } from '../../settings/sapPoApi.js';
import { httpSapAdapter, interpretLookup } from './sapHttpAdapter.js';

/** A fake SAP: POST /po creates (or refuses by reference), GET /po?ref= looks up; CSRF token required on POST. */
let server: Server;
let base = '';
const created = new Map<string, string>();
const bodyOf = (req: IncomingMessage) => new Promise<string>((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const slow = u.pathname === '/slow';
    if (req.method === 'HEAD') {
      const reply = () => { res.writeHead(200, { 'x-csrf-token': 'tok1', 'set-cookie': 'SAP_SESSION=abc; Path=/' }); res.end(); };
      if (slow) { setTimeout(reply, 700); return; }
      return reply();
    }
    if (req.method === 'POST') {
      if (req.headers['x-csrf-token'] !== 'tok1' || !String(req.headers.cookie).includes('SAP_SESSION=abc')) { res.writeHead(403); return res.end('CSRF token validation failed'); }
      const body = JSON.parse(await bodyOf(req)) as { ZZREF: string };
      if (body.ZZREF === 'POD-BAD') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: { value: 'Vendor blocked' } } })); }
      if (body.ZZREF === 'POD-500') { res.writeHead(500); return res.end('dump'); }
      if (body.ZZREF === 'POD-SLOW') { setTimeout(() => res.end('{}'), 3000); return; }
      if (slow) { setTimeout(() => { res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ d: { PurchaseOrder: '4599999999' } })); }, 700); return; }
      const po = created.get(body.ZZREF) ?? `45${String(created.size + 1).padStart(8, '0')}`;
      created.set(body.ZZREF, po);
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ d: { PurchaseOrder: po } }));
    }
    const ref = u.searchParams.get('ref') ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ d: { results: created.has(ref) ? [{ PurchaseOrder: created.get(ref), ZZREF: ref }] : [] } }));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

const conf = (over = {}) => sapPoApiSchema.parse({
  mode: 'api', baseUrl: base, createPath: '/po', lookupPath: '/po?ref={reference}', user: 'u', password: 'p', referenceField: 'ZZREF', poNumberPath: 'd.PurchaseOrder', timeoutSeconds: 5, ...over,
});

describe('SAP PO HTTP adapter', () => {
  it('lists what is missing before the API can be used', () => {
    expect(sapPoApiProblems(sapPoApiSchema.parse({ mode: 'api' }))).toEqual(['Base URL (https://…)', 'Create path', 'Lookup path with {reference}', 'SAP field for the portal reference', 'User and password']);
    expect(sapPoApiProblems(sapPoApiSchema.parse({}))).toEqual([]); // the simulator needs nothing
    expect(sapPoApiProblems(conf())).toEqual([]);
  });

  it('creates with a CSRF token, then finds the PO by its reference', async () => {
    const a = httpSapAdapter(conf());
    expect(await a.createPo('key-1', 'POD-000001', 'hash', { items: [] })).toEqual({ kind: 'CREATED', poNumber: '4500000001' });
    expect(await a.findPoByReference('POD-000001')).toEqual({ kind: 'FOUND', poNumber: '4500000001' });
    expect(await a.findPoByReference('POD-999999')).toEqual({ kind: 'NOT_FOUND' });
  });

  it('a 4xx is a rejection with SAP\'s message; a 5xx, a timeout or no answer is unknown (never assumed not created)', async () => {
    const a = httpSapAdapter(conf());
    expect(await a.createPo('k', 'POD-BAD', 'h', {})).toEqual({ kind: 'REJECTED', errors: ['SAP 400: Vendor blocked'] });
    expect((await a.createPo('k', 'POD-500', 'h', {})).kind).toBe('UNKNOWN');
    expect(await httpSapAdapter(conf({ timeoutSeconds: 5 })).createPo('k', 'POD-SLOW', 'h', {})).toMatchObject({ kind: 'UNKNOWN', detail: expect.stringContaining('without a PO number') }); // a 2xx without a PO number is not assumed created
    expect((await httpSapAdapter(conf({ baseUrl: 'http://127.0.0.1:1' })).createPo('k', 'POD-X', 'h', {})).kind).toBe('UNKNOWN');
    expect((await httpSapAdapter(conf({ csrf: false })).createPo('k', 'POD-Y', 'h', {}))).toMatchObject({ kind: 'REJECTED' }); // 403 without the token
  });

  it('one budget covers the CSRF fetch and the POST together', async () => {
    // each request alone (0.7 s) fits the 1 s budget; both together do not: unknown, never a second full timeout
    const a = httpSapAdapter(conf({ createPath: '/slow' }), 1000);
    const t0 = Date.now();
    expect(await a.createPo('k', 'POD-Z', 'h', {})).toMatchObject({ kind: 'UNKNOWN', detail: expect.stringContaining('No reply from SAP') });
    expect(Date.now() - t0).toBeLessThan(1600);
    expect(await httpSapAdapter(conf({ createPath: '/slow' }), 2500).createPo('k', 'POD-Z', 'h', {})).toEqual({ kind: 'CREATED', poNumber: '4599999999' }); // both fit
  });

  it('a production server refuses http:// and self-signed certificates (settings problems, save and send)', async () => {
    const insecure = conf({ baseUrl: 'http://sap.example.com', allowSelfSigned: true });
    expect(sapPoApiProblems(insecure, 'production')).toEqual(['a production server needs an https:// base URL', 'a production server does not accept self-signed certificates']);
    expect(sapPoApiProblems(insecure, 'development')).toEqual([]);
    expect(sapPoApiProblems(conf({ baseUrl: 'https://sap.example.com' }), 'production')).toEqual([]);
    // refused before anything is written (the database is never touched)
    await expect(saveSapPoApi(null as never, 'key', insecure, 'production')).rejects.toMatchObject({ code: 'SAP_PO_INSECURE' });
  });

  it('caps the timeout so the whole call stays inside the outbox lease', () => {
    expect(sapPoApiSchema.safeParse({ timeoutSeconds: 120 }).success).toBe(true);
    expect(sapPoApiSchema.safeParse({ timeoutSeconds: 121 }).success).toBe(false);
  });
});

describe('interpretLookup: NOT_FOUND only for a well-formed empty OData list', () => {
  const c = { referenceField: 'ZZREF', poNumberPath: 'd.PurchaseOrder' };
  const JSON_CT = 'application/json; charset=utf-8';
  const look = (body: unknown, status = 200, ct: string | null = JSON_CT) => interpretLookup(status, ct, typeof body === 'string' ? body : JSON.stringify(body), 'POD-000007', c);

  it('empty v2 and v4 lists are "not found"', () => {
    expect(look({ d: { results: [] } })).toEqual({ kind: 'NOT_FOUND' });
    expect(look({ '@odata.context': '$metadata#PO', value: [] })).toEqual({ kind: 'NOT_FOUND' });
  });

  it('anything unreadable is unknown, never "not found"', () => {
    expect(look({})).toMatchObject({ kind: 'UNKNOWN', detail: expect.stringContaining('without a list') });
    expect(look({ d: {} })).toMatchObject({ kind: 'UNKNOWN' });
    expect(look('<html><body>Logon</body></html>', 200, 'text/html')).toMatchObject({ kind: 'UNKNOWN', detail: expect.stringContaining('not JSON') });
    expect(look('{"d":{"results":[]}}', 200, null)).toMatchObject({ kind: 'UNKNOWN' }); // right shape, no JSON content type
    expect(look('{"d": {"results": [', 200)).toMatchObject({ kind: 'UNKNOWN', detail: expect.stringContaining('unreadable') });
    expect(look({ error: { code: 'X', message: { value: 'Service not found' } } })).toMatchObject({ kind: 'UNKNOWN', detail: expect.stringContaining('Service not found') });
    expect(look({ error: { message: 'Resource not found' } }, 404)).toMatchObject({ kind: 'UNKNOWN', detail: expect.stringContaining('SAP 404') });
    expect(look('dump', 500, 'text/plain')).toMatchObject({ kind: 'UNKNOWN', detail: expect.stringContaining('SAP 500') });
  });

  it('a list with records for other references means the filter was ignored: unknown', () => {
    expect(look({ d: { results: [{ PurchaseOrder: '4500000001', ZZREF: 'POD-000001' }, { PurchaseOrder: '4500000002', ZZREF: 'POD-000002' }] } }))
      .toMatchObject({ kind: 'UNKNOWN', detail: expect.stringContaining('filter may have been ignored') });
    expect(look({ value: [{ PurchaseOrder: '4500000001' }] })).toMatchObject({ kind: 'UNKNOWN' }); // no reference on the record
  });

  it('exactly our reference: found; the same PO twice is still one PO; two POs are for a person', () => {
    expect(look({ d: { results: [{ PurchaseOrder: '4500000007', ZZREF: 'POD-000007' }] } })).toEqual({ kind: 'FOUND', poNumber: '4500000007' });
    expect(look({ value: [{ PurchaseOrder: '4500000007', ZZREF: 'POD-000007' }, { PurchaseOrder: '4500000001', ZZREF: 'POD-000001' }] })).toEqual({ kind: 'FOUND', poNumber: '4500000007' });
    expect(look({ value: [{ PurchaseOrder: '4500000007', ZZREF: 'POD-000007' }, { PurchaseOrder: '4500000007', ZZREF: 'POD-000007' }] })).toEqual({ kind: 'FOUND', poNumber: '4500000007' });
    expect(look({ value: [{ PurchaseOrder: '4500000007', ZZREF: 'POD-000007' }, { PurchaseOrder: '4500000008', ZZREF: 'POD-000007' }] }))
      .toMatchObject({ kind: 'UNKNOWN', detail: expect.stringContaining('2 purchase orders') });
    expect(look({ value: [{ ZZREF: 'POD-000007' }] })).toMatchObject({ kind: 'UNKNOWN', detail: expect.stringContaining('no PO number') });
  });
});
