import { Typography } from 'antd';
import { Link } from 'react-router-dom';
import { TEAM_LOOK } from '../../components/DemandProgress';
import { History } from '../../components/StepText';
import { ProcessSteps, StatusBlock } from '../../components/StatusTag';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { RFQ_STATUS, RFQ_STEPS } from '../../lib/statuses';

type Rfq = RouterOutputs['rfq']['get'];
type Prog = RouterOutputs['rfq']['progress'] | undefined;

/** The RFQ page header (spec 21): process steps, then Sent to / Sent / Who has it / Next / History. */
export function RfqStatus({ rfq: r, prog }: { rfq: Rfq; prog?: Prog }) {
  const def = RFQ_STATUS[r.status];
  const firstQuote = (code: string) => r.quotes.filter((q) => q.supplierCode === code).map((q) => q.recordedAt).sort()[0];
  const sentTo = r.suppliers.map((s, i) => {
    const at = firstQuote(s.supplierCode);
    return (
      <span key={s.supplierCode}>{i > 0 && ' · '}{s.name} — {at
        ? <Typography.Text strong style={{ color: '#389e0d' }}>✓ quoted {formatDateTime(at)}</Typography.Text>
        : <Typography.Text style={{ color: '#d48806' }}>{r.manualStatus === 'DRAFT' ? 'invited, not sent yet' : 'no quote yet'}</Typography.Text>}</span>
    );
  });
  const missing = r.suppliers.filter((s) => !firstQuote(s.supplierCode)).map((s) => s.name);
  const next = r.status === 'QUOTING' && missing.length
    ? <>Record {missing.join(', ')}'s quote when it arrives, or award now{r.actions.award ? <> — <Link to={`/rfqs/${r.rfqId}/award`}>Award…</Link></> : null}</>
    : <>{def?.next}{(r.status === 'QUOTING' || r.status === 'PARTIALLY_AWARDED') && r.actions.award ? <> — <Link to={`/rfqs/${r.rfqId}/award`}>Award…</Link></> : null}</>;

  // Once something is awarded, who acts next and the step come from the server's stages (demand progress): awarded parts
  // are Procurement's to hand off, handed-off ones the PO team's.
  const awardedPhase = r.status === 'FULLY_AWARDED' || r.status === 'PARTIALLY_AWARDED';
  const waiting = awardedPhase ? (prog?.waitingOn ?? []) : [];
  const actions = waiting.filter((w) => w.team !== 'NONE');
  const p = prog?.progress;
  const step = r.status === 'FULLY_AWARDED' && p && p.awarded === 0 && p.handedOff + p.poPrep + p.onPo + p.onPoSimulated > 0 ? 4 : def?.step ?? -1;
  return (
    <>
      <ProcessSteps steps={RFQ_STEPS} current={step} />
      <StatusBlock rows={[
        { label: r.manualStatus === 'DRAFT' ? 'Invited' : 'Sent to', value: sentTo },
        { label: 'Sent', value: r.sentAt ? `by ${r.sentBy} on ${formatDateTime(r.sentAt)} — the supplier view was downloaded and e-mailed outside the app` : null },
        { label: 'Cancelled', value: r.cancelled ? `by ${r.cancelled.by} on ${formatDateTime(r.cancelled.at)} · ${r.cancelled.reason}${r.cancelled.comment ? ` — ${r.cancelled.comment}` : ''}` : null },
        { label: 'Who has it', value: waiting.length
          ? <>{waiting.map((w, i) => <span key={w.team}>{i > 0 ? ', ' : ''}<b style={{ color: TEAM_LOOK[w.team].color }}>{TEAM_LOOK[w.team].label}</b></span>)}
            {prog?.procurementDone && actions.length ? ' — Procurement has nothing left to do' : ''}</>
          : def?.who },
        { label: 'Next', value: actions.length ? <>{actions.map((w) => `${TEAM_LOOK[w.team].label}: ${w.text}`).join(' · ')}</> : next },
        { label: 'History', value: <History steps={r.steps} /> },
      ]} />
    </>
  );
}
