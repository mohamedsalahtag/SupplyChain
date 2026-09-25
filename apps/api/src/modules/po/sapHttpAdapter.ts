/**
 * The PO adapter for the company's SAP PO API (Configuration → SAP purchase orders, mode "api").
 * Generic on purpose until the API's contract is known: POST the frozen payload plus the portal reference to the
 * create path; GET the lookup path with {reference}. Replies are classified so the outbox never guesses:
 *   2xx with a PO number → CREATED · 4xx (bad data, refused) → REJECTED · timeout / network / 5xx / odd reply → UNKNOWN.
 * When the real API is delivered, only `toSapBody` (field mapping) is expected to change.
 */
import { Agent, fetch } from 'undici';
import type { SapPoApi } from '../../settings/sapPoApi.js';
import type { CreateResult, LookupResult, SapPoAdapter } from './sapAdapter.js';

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
type Json = Record<string, unknown>;

/** "d.PurchaseOrder" → obj.d.PurchaseOrder */
export function pick(obj: unknown, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Json)[k] : undefined), obj);
}

/** The first record of a reply that may be one object, an OData v2 list (d.results) or a v4 list (value). */
export function firstRecord(body: unknown): unknown {
  const b = body as Json | null;
  const list = (pick(b, 'd.results') ?? pick(b, 'value')) as unknown[] | undefined;
  if (Array.isArray(list)) return list[0];
  return b;
}

/** SAP error text from the usual OData error shapes, else the raw text. */
export function sapMessage(body: unknown, text: string): string {
  const m = pick(body, 'error.message.value') ?? pick(body, 'error.message') ?? pick(body, 'message');
  return (typeof m === 'string' && m) || text.slice(0, 500) || 'no message';
}

/** The body SAP receives. Until the API contract is agreed: the portal payload plus the reference field. */
export function toSapBody(c: SapPoApi, reference: string, payload: unknown): Json {
  return { ...(payload as Json), [c.referenceField]: reference };
}

export function httpSapAdapter(c: SapPoApi): SapPoAdapter {
  const url = (path: string) => {
    const u = new URL(c.baseUrl.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''));
    if (c.sapClient) u.searchParams.set('sap-client', c.sapClient);
    return u;
  };
  const auth = (): Record<string, string> => (c.authType === 'basic' ? { Authorization: 'Basic ' + Buffer.from(`${c.user}:${c.password}`).toString('base64') } : {});
  const common = () => ({ dispatcher: c.allowSelfSigned ? insecureAgent : undefined, signal: AbortSignal.timeout(c.timeoutSeconds * 1000) });
  const readBody = async (res: Awaited<ReturnType<typeof fetch>>) => {
    const text = await res.text();
    try { return { text, json: JSON.parse(text) as unknown }; } catch { return { text, json: null }; }
  };

  /** SAP Gateway: fetch a CSRF token (and its session cookie) before the POST. */
  async function csrf(): Promise<Record<string, string>> {
    if (!c.csrf) return {};
    const res = await fetch(url(c.createPath), { method: 'HEAD', headers: { ...auth(), 'X-CSRF-Token': 'Fetch' }, ...common() });
    const token = res.headers.get('x-csrf-token');
    const cookies = res.headers.getSetCookie?.().map((x) => x.split(';')[0]).join('; ') ?? '';
    return token ? { 'X-CSRF-Token': token, ...(cookies ? { Cookie: cookies } : {}) } : {};
  }

  return {
    async createPo(idempotencyKey, reference, payloadSha256, payload): Promise<CreateResult> {
      let res;
      try {
        res = await fetch(url(c.createPath), {
          method: 'POST',
          headers: {
            ...auth(), ...(await csrf()), 'Content-Type': 'application/json', Accept: 'application/json',
            'Idempotency-Key': idempotencyKey, 'X-Portal-Reference': reference, 'X-Payload-SHA256': payloadSha256,
          },
          body: JSON.stringify(toSapBody(c, reference, payload)),
          ...common(),
        });
      } catch (e) {
        return { kind: 'UNKNOWN', detail: `No reply from SAP: ${e instanceof Error ? e.message : String(e)}` }; // may or may not have been created
      }
      const { text, json } = await readBody(res);
      if (res.ok) {
        const po = pick(json, c.poNumberPath) ?? pick(firstRecord(json), c.poNumberPath.replace(/^d\./, ''));
        return po ? { kind: 'CREATED', poNumber: String(po) } : { kind: 'UNKNOWN', detail: `SAP answered ${res.status} without a PO number at "${c.poNumberPath}"` };
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        return { kind: 'REJECTED', errors: [`SAP ${res.status}: ${sapMessage(json, text)}`] };
      }
      return { kind: 'UNKNOWN', detail: `SAP ${res.status}: ${sapMessage(json, text)}` };
    },

    async findPoByReference(reference): Promise<LookupResult> {
      let res;
      try {
        res = await fetch(url(c.lookupPath.replace('{reference}', encodeURIComponent(reference))), { headers: { ...auth(), Accept: 'application/json' }, ...common() });
      } catch (e) {
        return { kind: 'UNKNOWN', detail: `No reply from SAP: ${e instanceof Error ? e.message : String(e)}` };
      }
      const { text, json } = await readBody(res);
      if (res.status === 404) return { kind: 'NOT_FOUND' };
      if (!res.ok) return { kind: 'UNKNOWN', detail: `SAP ${res.status}: ${sapMessage(json, text)}` };
      const rec = firstRecord(json);
      if (rec === undefined) return { kind: 'NOT_FOUND' };
      const po = pick(rec, c.poNumberPath.replace(/^d\./, '')) ?? pick(json, c.poNumberPath);
      return po ? { kind: 'FOUND', poNumber: String(po) } : { kind: 'NOT_FOUND' };
    },
  };
}
