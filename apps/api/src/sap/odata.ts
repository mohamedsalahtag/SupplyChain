/** Minimal OData v2 GET client for SAP. Read-only; basic auth; optional self-signed TLS. */
import { Agent, fetch } from 'undici';
import type { SapConnection } from '../settings/sapConnection.js';

const TIMEOUT_MS = 60_000;
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

export type ODataQuery = Record<string, string>;
type V2Body = { d?: { results?: unknown[]; __count?: string } };

function buildUrl(conn: SapConnection, query: ODataQuery): URL {
  const url = new URL(conn.baseUrl.replace(/\/+$/, '') + '/' + conn.materialsPath.replace(/^\/+/, ''));
  url.searchParams.set('$format', 'json');
  if (conn.sapClient) url.searchParams.set('sap-client', conn.sapClient);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url;
}

async function get(conn: SapConnection, query: ODataQuery): Promise<V2Body> {
  const res = await fetch(buildUrl(conn, query), {
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
  return (await res.json()) as V2Body;
}

/** Row count for a filter, without fetching rows. */
export async function countRows(conn: SapConnection, filter: string): Promise<number> {
  const body = await get(conn, { $filter: filter, $top: '0', $inlinecount: 'allpages' });
  return Number(body.d?.__count ?? 0);
}

/**
 * Every row matching the filter, paged by $skip. Throws — never returns a
 * partial list — if a page fails or the page ceiling is hit.
 */
export async function fetchAllRows(
  conn: SapConnection,
  opts: { filter?: string; select?: string; orderBy: string; pageSize?: number; maxPages?: number },
): Promise<Record<string, unknown>[]> {
  const { pageSize = 5000, maxPages = 200 } = opts;
  const rows: Record<string, unknown>[] = [];
  for (let page = 0; page < maxPages; page++) {
    const body = await get(conn, {
      ...(opts.filter ? { $filter: opts.filter } : {}),
      ...(opts.select ? { $select: opts.select } : {}),
      $orderby: opts.orderBy,
      $top: String(pageSize),
      $skip: String(page * pageSize),
    });
    const results = (body.d?.results ?? []) as Record<string, unknown>[];
    rows.push(...results);
    if (results.length < pageSize) return rows;
  }
  throw new Error(`SAP returned more than ${maxPages * pageSize} rows; sync stopped so a partial list is not saved`);
}
