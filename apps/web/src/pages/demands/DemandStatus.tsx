import { Link } from 'react-router-dom';
import { History } from '../../components/StepText';
import { ProcessSteps, StatusBlock } from '../../components/StatusTag';
import type { RouterOutputs } from '../../lib/format';
import { ACK_STATUS, DEMAND_STATUS, DEMAND_STEPS } from '../../lib/statuses';
import { trpc } from '../../lib/trpc';

type Demand = RouterOutputs['demand']['get'];
const BUCKETS: [label: string, states: string[]][] = [
  ['On PO', ['PO_SUBMITTED', 'PO_CREATED']], ['Awarded', ['AWARDED', 'HANDED_OFF', 'PO_PREPARATION']], ['In RFQ', ['IN_RFQ', 'QUOTED']], ['Open', ['OPEN']], ['Cancelled', ['CANCELLED']],
];
const fmt = (milli: number) => (milli / 1000).toLocaleString('en-GB', { maximumFractionDigits: 3 });

/** The demand page header (spec 21): process steps, then Now / Who has it / Next / History. */
export function DemandStatus({ demand: d }: { demand: Demand }) {
  const accepted = d.workflowStatus === 'ACCEPTED';
  const awards = trpc.award.list.useQuery({ demandId: d.demandId, page: 1, pageSize: 100 }, { enabled: accepted });
  const def = DEMAND_STATUS[d.status];

  // Quantity per stage and unit, from the line ledgers.
  const lines = d.weeks.flatMap((w) => w.lines);
  const per = BUCKETS.map(([label, states]) => {
    const byUnit = new Map<string, number>();
    for (const l of lines) for (const s of states) byUnit.set(l.unit, (byUnit.get(l.unit) ?? 0) + Math.round(Number(l.ledger.byState[s as keyof typeof l.ledger.byState] ?? 0) * 1000));
    return { label, text: [...byUnit].filter(([, v]) => v > 0).map(([u, v]) => `${fmt(v)} ${u}`).join(' + ') };
  }).filter((b) => b.text);
  const has = (label: string) => per.some((b) => b.label === label);
  // Where on the path: all awarded (nothing open or in RFQ) is "Awarded"; all on PO is "Ordered".
  const step = accepted && d.status === 'FULLY_IN_EXECUTION' && !has('In RFQ') && !has('Open') ? (has('Awarded') ? 4 : 5) : def?.step ?? -1;

  const requested = (() => {
    const byUnit = new Map<string, number>();
    for (const l of lines) byUnit.set(l.unit, (byUnit.get(l.unit) ?? 0) + Math.round(Number(l.ledger.requested) * 1000));
    return [...byUnit].filter(([, v]) => v > 0).map(([u, v]) => `${fmt(v)} ${u}`).join(' + ');
  })();
  const containers = d.weeks.reduce((t, w) => t + w.containerCount, 0);
  const awardText = (awards.data?.rows ?? []).map((a) => `${a.abNo} (${(ACK_STATUS[a.ackStatus]?.label ?? a.ackStatus).toLowerCase()})`).join(', ');
  const now = accepted
    ? <>{per.map((b) => `${b.label} ${b.text}`).join(' · ')}{has('Open') ? ' — no supplier has been asked for the open part yet' : ''}{awardText ? <> · awards: {awardText}</> : null}</>
    : <>{requested || 'No materials yet'} in {containers} container(s){d.workflowStatus === 'SUBMITTED' ? ' — submitted, not yet accepted' : ''}</>;
  const next = d.status === 'MERGED' && d.mergedIntoDemand
    ? <>Continue on <Link to={`/demands/${d.mergedIntoDemand.demandId}`}>{d.mergedIntoDemand.demandNo}</Link></>
    : <>{def?.next}{d.actions.createRfq && has('Open') ? <> — <Link to={`/rfqs/new?demand=${d.demandId}`}>Create RFQ…</Link></> : null}</>;

  return (
    <>
      <ProcessSteps steps={DEMAND_STEPS} current={step} />
      <StatusBlock rows={[
        { label: 'Now', value: now },
        { label: 'Who has it', value: def?.who },
        { label: 'Next', value: next },
        { label: 'History', value: <History steps={d.steps} /> },
      ]} />
    </>
  );
}
