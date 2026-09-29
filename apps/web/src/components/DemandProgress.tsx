import { Card, Space, Table, Tag, Tooltip, Typography, theme } from 'antd';
import { Link } from 'react-router-dom';
import type { RouterOutputs } from '../lib/format';

type Stage = 'onPo' | 'onPoSimulated' | 'poPrep' | 'handedOff' | 'awarded' | 'quoted' | 'inRfq' | 'open' | 'cancelled';
type Progress = Record<Stage, number>;
type Waiting = RouterOutputs['demand']['list']['rows'][number]['waitingOn'][number];
type Left = Pick<RouterOutputs['demand']['progress'], 'rows' | 'procurementDone'>;

const SIM_BG = 'repeating-linear-gradient(45deg,#95de64 0 4px,#237804 4px 8px)';
/** Each stage: label, colour, whose turn (the server decides the stages; these are only their names and colours). */
export const STAGE_LOOK: Record<Stage, { label: string; color: string; owner: string; tag: string }> = {
  onPo: { label: 'on PO', color: '#237804', owner: 'on SAP purchase orders', tag: 'green' },
  onPoSimulated: { label: 'on PO (simulated)', color: SIM_BG, owner: 'simulator — not in SAP', tag: 'orange' },
  poPrep: { label: 'PO preparation', color: '#13c2c2', owner: 'PO team to submit', tag: 'cyan' },
  handedOff: { label: 'handed off', color: '#1677ff', owner: 'PO team to accept', tag: 'blue' },
  awarded: { label: 'awarded', color: '#faad14', owner: 'Procurement to hand off', tag: 'gold' },
  quoted: { label: 'quoted', color: '#b37feb', owner: 'Procurement to compare and award', tag: 'purple' },
  inRfq: { label: 'in RFQ', color: '#722ed1', owner: 'Procurement to record quotes', tag: 'geekblue' },
  open: { label: 'open', color: '#bfbfbf', owner: 'Procurement to put in an RFQ', tag: 'default' },
  cancelled: { label: 'cancelled', color: '#ff7875', owner: 'nobody', tag: 'red' },
};
const ORDER = Object.keys(STAGE_LOOK) as Stage[];

export const TEAM_LOOK: Record<Waiting['team'], { label: string; color: string }> = {
  PROCUREMENT: { label: 'Procurement', color: '#d48806' }, PO_TEAM: { label: 'PO team', color: '#0958d9' }, SALES: { label: 'Sales', color: '#531dab' }, NONE: { label: 'Nobody', color: '#389e0d' },
};

/** The coloured bar alone (the Demands list and the demand header). */
export function StageBar({ p, maxWidth }: { p: Progress; maxWidth?: number }) {
  const shown = ORDER.filter((k) => p[k] > 0);
  return (
    <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: '#f0f0f0', marginTop: 4, maxWidth }}>
      {shown.map((k) => <span key={k} style={{ width: `${p[k]}%`, background: STAGE_LOOK[k].color }} />)}
    </div>
  );
}

export const stageText = (p: Progress) => ORDER.filter((k) => p[k] > 0).map((k) => `${Math.round(p[k])}% ${STAGE_LOOK[k].label}`).join(' · ');

/** How much of a demand's quantity is in each stage, and whose turn each part is (hover). */
export function Progress({ p }: { p: Progress | null | undefined }) {
  const { token } = theme.useToken();
  if (!p) return <Typography.Text type="secondary">—</Typography.Text>;
  const tip = ORDER.filter((k) => p[k] > 0).map((k) => <div key={k}>{p[k]}% {STAGE_LOOK[k].label} — {STAGE_LOOK[k].owner}</div>);
  return (
    <Tooltip title={<div>{tip}</div>}>
      <StageBar p={p} />
      <div style={{ fontSize: token.fontSizeSM, color: token.colorTextSecondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{stageText(p)}</div>
    </Tooltip>
  );
}

/** "PO team · accept HO-000027" — one line per team the demand waits on. */
export function WaitingOn({ w }: { w: Waiting[] | undefined }) {
  const { token } = theme.useToken();
  if (!w?.length) return <Typography.Text type="secondary">—</Typography.Text>;
  const text = w.map((x) => `${TEAM_LOOK[x.team].label} · ${x.text}`).join('\n');
  return (
    <Tooltip title={<div style={{ whiteSpace: 'pre-line' }}>{text}</div>}>
      <div style={{ fontSize: token.fontSizeSM, lineHeight: 1.5 }}>
        {w.map((x) => (
          <div key={x.team} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <b style={{ color: TEAM_LOOK[x.team].color }}>{TEAM_LOOK[x.team].label}</b> <span style={{ color: token.colorTextSecondary }}>· {x.text}</span>
          </div>
        ))}
      </div>
    </Tooltip>
  );
}

/** The demand page's "What's left": one line per part that is not finished, where it is, who acts next, a link. */
export function WhatsLeft({ data, title = "What's left", note = 'one line per part that is not finished' }: { data: Left; title?: string; note?: string }) {
  const { token } = theme.useToken();
  const small = { fontSize: token.fontSizeSM, color: token.colorTextSecondary };
  return (
    <Card size="small" title={<Space size={8}><span>{title}</span><Typography.Text type="secondary" style={{ fontWeight: 400 }}>{note}</Typography.Text></Space>}
      extra={data.procurementDone ? <Tag color="green">Procurement: nothing left to do</Tag> : <Tag color="gold">Procurement has work here</Tag>}>
      {data.rows.length === 0
        ? <Typography.Text type="secondary">Nothing left — every part is on a purchase order or cancelled.</Typography.Text>
        : (
          <Table size="small" bordered pagination={false} rowKey="key" dataSource={data.rows} tableLayout="fixed" columns={[
            { title: 'Part', key: 'part', width: '24%', render: (_: unknown, r: Left['rows'][number]) => (
              <div>{r.supplier ?? r.what}{r.award && r.supplier && <div style={small}>{r.award}</div>}</div>) },
            { title: 'Quantity', key: 'qty', width: '11%', align: 'right' as const, render: (_: unknown, r: Left['rows'][number]) => r.quantity || '—' },
            { title: 'Where it is', key: 'where', width: '33%', render: (_: unknown, r: Left['rows'][number]) => (
              <div>
                <Space size={4} wrap>{r.stages.map((s) => <Tag key={s.stage} color={STAGE_LOOK[s.stage].tag} style={{ marginInlineEnd: 0 }}>{STAGE_LOOK[s.stage].label}{r.stages.length > 1 ? ` ${s.quantity}` : ''}</Tag>)}</Space>
                <div style={small}>{r.where}</div>
              </div>) },
            { title: 'Who acts next', key: 'who', width: '20%', render: (_: unknown, r: Left['rows'][number]) => (
              <div><b style={{ color: TEAM_LOOK[r.team].color }}>{TEAM_LOOK[r.team].label}</b><div style={small}>{r.next}</div></div>) },
            { title: '', key: 'link', width: '12%', render: (_: unknown, r: Left['rows'][number]) => (r.link ? <Link to={r.link.to}>{r.link.label}</Link> : null) },
          ]} />
        )}
    </Card>
  );
}
