import type { ReactNode } from 'react';
import { Badge, Space } from 'antd';

/** How many records a query's data holds: an array, a paged list ({ rows, total }) or nothing yet. */
export function countOf(data: unknown): number | undefined {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object') {
    const d = data as { total?: unknown; rows?: unknown };
    if (typeof d.total === 'number') return d.total;
    if (Array.isArray(d.rows)) return d.rows.length;
  }
  return undefined;
}

/**
 * A tab title with the number of records inside it (user request 2026-09-25): "Versions (2)" as a badge.
 * Nothing while loading; a grey 0 when empty, so an empty tab is visible without opening it.
 */
export function TabLabel({ text, count }: { text: ReactNode; count: number | undefined }) {
  return (
    <Space size={6}>
      {text}
      {count !== undefined && <Badge count={count} showZero overflowCount={999} color={count ? '#1f6f43' : '#bfbfbf'} style={{ boxShadow: 'none' }} />}
    </Space>
  );
}
