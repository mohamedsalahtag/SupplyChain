/**
 * The PO adapter for the company's SAP PO API (Configuration → SAP purchase orders, mode "api").
 * Generic on purpose until the API's contract is known: POST the frozen payload plus the portal reference to the
 * create path; GET the lookup path with {reference}. Replies are classified so the outbox never guesses:
 *   2xx with a PO number → CREATED · 4xx (bad data, refused) → REJECTED · timeout / network / 5xx / odd reply → UNKNOWN.
 * A lookup says NOT_FOUND only for a well-formed, empty OData list (interpretLookup): anything it cannot read is UNKNOWN,
 * because NOT_FOUND makes the outbox send again. One budget (timeoutSeconds) covers the whole call, CSRF fetch included.
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

/**
 * Reads a lookup reply. NOT_FOUND (which makes the outbox resend) only for a JSON reply that is an OData list — v2
 * `d.results` or v4 `value` — and is empty. A found record must carry the reference we asked for (a list whose records
 * all carry other references means SAP ignored the filter); two different POs for one reference are for a person.
 * Everything else — HTML, `{}`, an unknown shape, an OData error, a 404 (not a confirmed absence until the API contract
 * says so: a wrong path is a 404 too) — is UNKNOWN with the reason.
 */
export function interpretLookup(status: number, contentType: string | null, text: string, reference: string, c: Pick<SapPoApi, 'referenceField' | 'poNumberPath'>): LookupResult {
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (status < 200 || status >= 300) return { kind: 'UNKNOWN', detail: `SAP ${status}: ${sapMessage(json, text)}` };
  if (!/^application\/json\b/i.test((contentType ?? '').trim())) return { kind: 'UNKNOWN', detail: `SAP answered ${status} with ${contentType || 'no content type'}, not JSON: ${text.slice(0, 200)}` };
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { kind: 'UNKNOWN', detail: `SAP answered ${status} with unreadable JSON: ${text.slice(0, 200)}` };
  if (pick(json, 'error') !== undefined) return { kind: 'UNKNOWN', detail: `SAP answered ${status} with an error: ${sapMessage(json, text)}` };
  const v2 = pick(json, 'd.results');
  const v4 = pick(json, 'value');
  const list = Array.isArray(v2) ? v2 : Array.isArray(v4) ? v4 : null;
  if (!list) return { kind: 'UNKNOWN', detail: `SAP answered ${status} without a list (d.results or value): ${text.slice(0, 200)}` };
  if (!list.length) return { kind: 'NOT_FOUND' };
  const matches = list.filter((r) => { const ref = pick(r, c.referenceField); return ref !== undefined && ref !== null && String(ref).trim() === reference; });
  if (!matches.length) return { kind: 'UNKNOWN', detail: `SAP returned ${list.length} record(s), none with ${c.referenceField} = ${reference} — the lookup filter may have been ignored` };
  const poPath = c.poNumberPath.replace(/^d\./, '');
  const pos = [...new Set(matches.map((r) => pick(r, poPath)).filter((x) => x !== undefined && x !== null && String(x) !== '').map(String))];
  if (!pos.length) return { kind: 'UNKNOWN', detail: `SAP has ${reference} but no PO number at "${poPath}"` };
  if (pos.length > 1) return { kind: 'UNKNOWN', detail: `SAP has ${pos.length} purchase orders for ${reference} (${pos.join(', ')}) — a person must check` };
  return { kind: 'FOUND', poNumber: pos[0] };
}

/** The body SAP receives. Until the API contract is agreed: the portal payload plus the reference field. */
export function toSapBody(c: SapPoApi, reference: string, payload: unknown): Json {
  return { ...(payload as Json), [c.referenceField]: reference };
}

/** `budgetMs` (tests only) overrides the whole-call budget, which is timeoutSeconds. */
export function httpSapAdapter(c: SapPoApi, budgetMs = c.timeoutSeconds * 1000): SapPoAdapter {
  const url = (path: string) => {
    const u = new URL(c.baseUrl.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''));
    if (c.sapClient) u.searchParams.set('sap-client', c.sapClient);
    return u;
  };
  const auth = (): Record<string, string> => (c.authType === 'basic' ? { Authorization: 'Basic ' + Buffer.from(`${c.user}:${c.password}`).toString('base64') } : {});
  // One deadline per operation, shared by every request in it (CSRF HEAD + POST): the call never outlives its budget.
  const common = (signal: AbortSignal) => ({ dispatcher: c.allowSelfSigned ? insecureAgent : undefined, signal });
  const readBody = async (res: Awaited<ReturnType<typeof fetch>>) => {
    const text = await res.text();
    try { return { text, json: JSON.parse(text) as unknown }; } catch { return { text, json: null }; }
  };

  /** SAP Gateway: fetch a CSRF token (and its session cookie) before the POST. */
  async function csrf(signal: AbortSignal): Promise<Record<string, string>> {
    if (!c.csrf) return {};
    const res = await fetch(url(c.createPath), { method: 'HEAD', headers: { ...auth(), 'X-CSRF-Token': 'Fetch' }, ...common(signal) });
    const token = res.headers.get('x-csrf-token');
    const cookies = res.headers.getSetCookie?.().map((x) => x.split(';')[0]).join('; ') ?? '';
    return token ? { 'X-CSRF-Token': token, ...(cookies ? { Cookie: cookies } : {}) } : {};
  }

  return {
    async createPo(idempotencyKey, reference, payloadSha256, payload): Promise<CreateResult> {
      const signal = AbortSignal.timeout(budgetMs);
      let res;
      let body;
      try {
        res = await fetch(url(c.createPath), {
          method: 'POST',
          headers: {
            ...auth(), ...(await csrf(signal)), 'Content-Type': 'application/json', Accept: 'application/json',
            'Idempotency-Key': idempotencyKey, 'X-Portal-Reference': reference, 'X-Payload-SHA256': payloadSha256,
          },
          body: JSON.stringify(toSapBody(c, reference, payload)),
          ...common(signal),
        });
        body = await readBody(res); // the body read counts against the same budget
      } catch (e) {
        return { kind: 'UNKNOWN', detail: `No reply from SAP: ${e instanceof Error ? e.message : String(e)}` }; // may or may not have been created
      }
      const { text, json } = body;
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
      try {
        const res = await fetch(url(c.lookupPath.replace('{reference}', encodeURIComponent(reference))), { headers: { ...auth(), Accept: 'application/json' }, ...common(AbortSignal.timeout(budgetMs)) });
        const text = await res.text();
        return interpretLookup(res.status, res.headers.get('content-type'), text, reference, c);
      } catch (e) {
        return { kind: 'UNKNOWN', detail: `No reply from SAP: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}
