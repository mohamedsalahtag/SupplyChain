import { useRef, useState } from 'react';
import { Tooltip, Typography } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { P } from '@supplychain/shared';
import { useCan } from '../../lib/auth';
import { trpc } from '../../lib/trpc';
import type { GroupDraft } from './GroupCard';

type Hint =
  | { kind: 'from'; label: string; note: string | null; capacity: string }
  | { kind: 'none' }
  | { kind: 'unit'; unit: string; capacity: number };

/**
 * Spec 32: when materials are added, the group's capacity per container starts from Configuration → Container capacity
 * — but only while the field is empty or still holds the last suggestion. A number typed by hand is never overwritten.
 * `capacitySuggested` lives in the draft only; the saved payload does not carry it.
 */
export function useCapacitySuggestion(group: GroupDraft, onChange: (g: GroupDraft) => void) {
  const utils = trpc.useUtils();
  const [hint, setHint] = useState<Hint | null>(null);
  // The fetch is asynchronous: apply its answer to the group as it is then, not as it was when materials were added.
  const latest = useRef({ group, onChange });
  latest.current = { group, onChange };

  /** `next`: the group just handed to onChange (the parent has not re-rendered yet). */
  const suggest = async (next: GroupDraft) => {
    latest.current = { ...latest.current, group: next };
    const items = next.items;
    if (!items.length) return;
    let r;
    try {
      r = await utils.workflowSetup.capacityFor.fetch({ items: items.map((i) => ({ majorCategory: i.majorCategory, subMajorCategory: i.subMajorCategory, size: i.size })) });
    } catch {
      return; // A default is a convenience: without it the user types the number as before.
    }
    const cur = latest.current.group;
    const untouched = cur.capacity === '' || cur.capacity === cur.capacitySuggested;
    if (!untouched) return setHint(null);
    if (r.capacity === null) return setHint({ kind: 'none' });
    if (cur.unit && r.unit && cur.unit !== r.unit) return setHint({ kind: 'unit', unit: r.unit, capacity: r.capacity });
    const capacity = String(r.capacity);
    latest.current.onChange({ ...cur, capacity, capacitySuggested: capacity, unit: cur.unit || r.unit || '' });
    setHint({ kind: 'from', label: r.source?.label ?? '', note: r.note, capacity });
  };
  return { hint, suggest };
}

/** The line under the capacity field: where the number came from, or that nothing is defined. */
export function CapacityHint({ hint, capacity }: { hint: Hint | null; capacity: string }) {
  const can = useCan();
  if (!hint) return null;
  const link = can(P.configCapacityEdit) ? <> · <Link to="/settings?tab=capacity" target="_blank" rel="noreferrer">Container capacity</Link></> : null;
  if (hint.kind === 'from') {
    if (capacity !== hint.capacity) return null; // changed by hand: the hint no longer describes the number
    return (
      <Typography.Text type="secondary">
        from Container capacity ({hint.label})
        {hint.note && <Tooltip title={hint.note}> <InfoCircleOutlined aria-label={hint.note} /></Tooltip>}
      </Typography.Text>
    );
  }
  if (hint.kind === 'unit') {
    if (capacity !== '') return null;
    return <Typography.Text type="warning">Container capacity is {hint.capacity} {hint.unit}, not in this group's unit: enter the number{link}</Typography.Text>;
  }
  if (capacity !== '') return null;
  return <Typography.Text type="secondary">no capacity defined for these products{link}</Typography.Text>;
}
