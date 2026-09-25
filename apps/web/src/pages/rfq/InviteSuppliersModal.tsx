import { useState } from 'react';
import { Alert, App, Checkbox, Modal, Skeleton, Space, Table, Tag, Typography } from 'antd';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId, problemsOf } from '../../lib/workflow';
import { OutsideSuppliers, type Outside } from './OutsideSuppliers';

/**
 * RFQ page → Suppliers → Invite more suppliers… (spec 18 addition): the RFQ's shortlist without those already invited,
 * plus any supplier in SAP not on the list (first contact). On a sent RFQ the newcomers still need the supplier view.
 */
export function InviteSuppliersModal({ open, onClose, rfqId, rfqNo, rowVer, sent }: { open: boolean; onClose: () => void; rfqId: string; rfqNo: string; rowVer: string; sent: boolean }) {
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const options = trpc.rfq.inviteOptions.useQuery({ rfqId }, { enabled: open });
  const invite = trpc.rfq.invite.useMutation();
  const [picked, setPicked] = useState<string[]>([]);
  const [outside, setOutside] = useState<Outside[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const close = () => { setPicked([]); setOutside([]); setProblems([]); onClose(); };
  const invitedAll = (options.data?.groups ?? []).flatMap((g) => g.invited);
  const listedAll = (options.data?.groups ?? []).flatMap((g) => g.entries.map((e) => e.supplierCode));
  const count = picked.length + outside.length;

  return (
    <Modal open={open} width={Math.min(980, window.innerWidth - 40)} title={`Invite more suppliers to ${rfqNo}`} destroyOnHidden onCancel={close}
      okText={count ? `Invite ${count} supplier(s)` : 'Invite'} okButtonProps={{ disabled: !count, loading: invite.isPending }}
      onOk={async () => {
        setProblems([]);
        try {
          const r = await invite.mutateAsync({ commandId: newCommandId(), rfqId, rowVer, suppliers: picked, extraSuppliers: outside.map((o) => o.supplierCode) });
          message.success(`${r.invited} supplier(s) invited${sent ? ' — send them the supplier view' : ''}`);
          await Promise.all([utils.rfq.invalidate(), utils.work.invalidate()]);
          close();
        } catch (err) { const p = problemsOf(err); setProblems(p.length ? p : [errorText(err)]); }
      }}>
      {sent && <Alert type="info" showIcon style={{ marginBottom: 8 }} message="This RFQ is already sent"
        description="Send the new suppliers the supplier view (Download supplier view). “Record quotes” comes back on My work until their quotes are in." />}
      {options.isPending ? <Skeleton active /> : (options.data?.groups ?? []).map((g) => (
        <div key={g.originCode} style={{ marginBottom: 10 }}>
          <Tag color="blue">{g.originCode}</Tag>
          {g.problem ? <Typography.Text type="secondary">{g.problem}</Typography.Text> : (
            <Table size="small" bordered pagination={false} rowKey="supplierCode" dataSource={g.entries} tableLayout="fixed" style={{ marginTop: 4 }} columns={[
              { title: '', key: 'c', width: 40, render: (_: unknown, e) => (g.invited.includes(e.supplierCode) ? null
                : <Checkbox checked={picked.includes(e.supplierCode)} aria-label={`Invite ${e.name}`} onChange={(ev) => setPicked(ev.target.checked ? [...picked, e.supplierCode] : picked.filter((x) => x !== e.supplierCode))} />) },
              { title: '#', key: 'r', width: 45, render: (_: unknown, e) => e.rank ?? '—' },
              { title: 'Supplier', key: 's', ellipsis: true, render: (_: unknown, e) => <>{g.invited.includes(e.supplierCode) && <Tag>invited</Tag>}{e.supplierCode} · {e.name}</> },
              { title: 'Our history', key: 'h', width: 330, render: (_: unknown, e) => (e.hint.matchLevel === 'NONE'
                ? <Typography.Text type="secondary">no history for this material/origin</Typography.Text>
                : `${e.hint.poCount} POs · last ${e.hint.lastPoDate}${e.hint.lastPrice ? ` at ${e.hint.lastPrice} ${e.hint.lastCurrency}` : ''}`) },
            ]} />
          )}
        </div>
      ))}
      {!options.isPending && <OutsideSuppliers source={{ rfqId }} value={outside} onChange={setOutside} shortlisted={[...listedAll, ...invitedAll]} />}
      {problems.length > 0 && <Alert type="error" showIcon style={{ marginTop: 8 }} message="Not invited" description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>} />}
      <Space style={{ marginTop: 8 }}><Typography.Text type="secondary">Already invited suppliers are marked and cannot be chosen again.</Typography.Text></Space>
    </Modal>
  );
}
