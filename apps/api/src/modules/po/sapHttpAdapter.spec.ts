import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sapPoApiSchema, sapPoApiProblems } from '../../settings/sapPoApi.js';
import { httpSapAdapter } from './sapHttpAdapter.js';

/** A fake SAP: POST /po creates (or refuses by reference), GET /po?ref= looks up; CSRF token required on POST. */
let server: Server;
let base = '';
const created = new Map<string, string>();
const bodyOf = (req: IncomingMessage) => new Promise<string>((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'HEAD') { res.writeHead(200, { 'x-csrf-token': 'tok1', 'set-cookie': 'SAP_SESSION=abc; Path=/' }); return res.end(); }
    if (req.method === 'POST') {
      if (req.headers['x-csrf-token'] !== 'tok1' || !String(req.headers.cookie).includes('SAP_SESSION=abc')) { res.writeHead(403); return res.end('CSRF token validation failed'); }
      const body = JSON.parse(await bodyOf(req)) as { ZZREF: string };
      if (body.ZZREF === 'POD-BAD') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: { value: 'Vendor blocked' } } })); }
      if (body.ZZREF === 'POD-500') { res.writeHead(500); return res.end('dump'); }
      if (body.ZZREF === 'POD-SLOW') { setTimeout(() => res.end('{}'), 3000); return; }
      const po = created.get(body.ZZREF) ?? `45${String(created.size + 1).padStart(8, '0')}`;
      created.set(body.ZZREF, po);
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ d: { PurchaseOrder: po } }));
    }
    const ref = u.searchParams.get('ref') ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ d: { results: created.has(ref) ? [{ PurchaseOrder: created.get(ref) }] : [] } }));
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
});
