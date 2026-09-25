import { Typography } from 'antd';
import { Link } from 'react-router-dom';
import { History } from '../../components/StepText';
import { ProcessSteps, StatusBlock } from '../../components/StatusTag';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { RFQ_STATUS, RFQ_STEPS } from '../../lib/statuses';

type Rfq = RouterOutputs['rfq']['get'];

/** The RFQ page header (spec 21): process steps, then Sent to / Sent / Who has it / Next / History. */
export function RfqStatus({ rfq: r }: { rfq: Rfq }) {
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

  return (
    <>
      <ProcessSteps steps={RFQ_STEPS} current={def?.step ?? -1} />
      <StatusBlock rows={[
        { label: r.manualStatus === 'DRAFT' ? 'Invited' : 'Sent to', value: sentTo },
        { label: 'Sent', value: r.sentAt ? `by ${r.sentBy} on ${formatDateTime(r.sentAt)} — the supplier view was downloaded and e-mailed outside the app` : null },
        { label: 'Cancelled', value: r.cancelled ? `by ${r.cancelled.by} on ${formatDateTime(r.cancelled.at)} · ${r.cancelled.reason}${r.cancelled.comment ? ` — ${r.cancelled.comment}` : ''}` : null },
        { label: 'Who has it', value: def?.who },
        { label: 'Next', value: next },
        { label: 'History', value: <History steps={r.steps} /> },
      ]} />
    </>
  );
}
