/**
 * Minimal read-only OData client for SAP: v2 (materials, business partners)
 * and v4 (purchase orders). Basic auth; optional self-signed TLS.
 */
import { Agent, fetch } from 'undici';
import type { SapConnection } from '../settings/sapConnection.js';

const TIMEOUT_MS = 120_000;
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

export type ODataVersion = 'v2' | 'v4';

/** Where to read: the full path to an entity set, e.g. "/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_Supplier". */
export type ODataTarget = { path: string; version: ODataVersion };

export type ODataQuery = {
  filter?: string;
  /** v2: "A,B,nav/C"; v4: "A,B". */
  select?: string;
  /** v2: "nav1,nav2/sub"; v4: "nav($select=A,B)". */
  expand?: string;
  orderBy: string;
};

type Row = Record<string, unknown>;
type Body = { d?: { results?: Row[]; __count?: string }; value?: Row[]; '@odata.count'?: number };

/** Joins a service root and an entity set: ("/x/API/", "A_Supplier") → "/x/API/A_Supplier". */
export const entityPath = (servicePath: string, entity: string) => `${servicePath.replace(/\/+$/, '')}/${entity}`;

function buildUrl(conn: SapConnection, t: ODataTarget, params: Record<string, string>): URL {
  const url = new URL(conn.baseUrl.replace(/\/+$/, '') + '/' + t.path.replace(/^\/+/, ''));
  if (t.version === 'v2') url.searchParams.set('$format', 'json');
  if (conn.sapClient) url.searchParams.set('sap-client', conn.sapClient);
  for (const [k, v] of Object.entries(params)) if (v !== '') url.searchParams.set(k, v);
  return url;
}

async function get(conn: SapConnection, t: ODataTarget, params: Record<string, string>): Promise<Body> {
  const res = await fetch(buildUrl(conn, t, params), {
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${conn.user}:${conn.password}`).toString('base64'),
      Accept: 'application/json',
    },
    dispatcher: conn.allowSelfSigned ? insecureAgent : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`SAP answered ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
  }
  return (await res.json()) as Body;
}

const rowsOf = (t: ODataTarget, b: Body): Row[] => (t.version === 'v2' ? (b.d?.results ?? []) : (b.value ?? []));

/** Row count for a filter, without fetching rows. */
export async function countRows(conn: SapConnection, t: ODataTarget, filter?: string): Promise<number> {
  if (t.version === 'v2') {
    const b = await get(conn, t, { $filter: filter ?? '', $top: '0', $inlinecount: 'allpages' });
    return Number(b.d?.__count ?? 0);
  }
  const b = await get(conn, t, { $filter: filter ?? '', $top: '0', $count: 'true' });
  return Number(b['@odata.count'] ?? 0);
}

/**
 * Reads every matching row page by page ($top/$skip; SAP serves at most 5,000
 * per page) and hands each page to `onPage`. Throws if a page fails or the page
 * ceiling is hit. Returns the number of rows read.
 */
export async function forEachPage(
  conn: SapConnection,
  t: ODataTarget,
  q: ODataQuery & { pageSize?: number; maxPages?: number },
  onPage: (rows: Row[]) => Promise<void> | void,
): Promise<number> {
  const { pageSize = 5000, maxPages = 400 } = q;
  let total = 0;
  for (let page = 0; page < maxPages; page++) {
    const rows = rowsOf(
      t,
      await get(conn, t, {
        $filter: q.filter ?? '',
        $select: q.select ?? '',
        $expand: q.expand ?? '',
        $orderby: q.orderBy,
        $top: String(pageSize),
        $skip: String(page * pageSize),
      }),
    );
    total += rows.length;
    await onPage(rows);
    if (rows.length < pageSize) return total;
  }
  throw new Error(`SAP returned more than ${maxPages * pageSize} rows; sync stopped`);
}

/** Every matching row in memory. Never returns a partial list: any failed page throws. */
export async function fetchAllRows(conn: SapConnection, t: ODataTarget, q: ODataQuery & { pageSize?: number }): Promise<Row[]> {
  const rows: Row[] = [];
  await forEachPage(conn, t, q, (page) => {
    rows.push(...page);
  });
  return rows;
}
