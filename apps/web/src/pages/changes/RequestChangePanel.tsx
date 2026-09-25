import { useState } from 'react';
import { App, Button, Card, Input, Modal, Select, Space, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, FileSearchOutlined, MergeCellsOutlined, RollbackOutlined, StopOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId, weekLabel } from '../../lib/workflow';

type Demand = RouterOutputs['demand']['get'];

function Choice({ icon, button, text, danger, onClick, extra }: { icon: React.ReactNode; button: string; text: string; danger?: boolean; onClick: () => void; extra?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
      <Space.Compact style={{ width: 360, flex: 'none' }}>
        {extra}
        <Button icon={icon} danger={danger} onClick={onClick} block={!extra}>{button}</Button>
      </Space.Compact>
      <Typography.Text type="secondary" style={{ flex: '1 1 300px' }}>{text}</Typography.Text>
    </div>
  );
}

/**
 * How to ask for a change (spec 14), shown on the demand itself: one button per kind
 * of request, each saying what it does. After acceptance, a demand changes only this way.
 */
export function RequestChangePanel({ demand: d }: { demand: Demand }) {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const recall = trpc.demand.recall.useMutation();
  const [taking, setTaking] = useState(false);
  const [why, setWhy] = useState('');
  const weeks = d.weeks.filter((w) => w.groups.length && !w.hold).map((w) => w.etdWeek);
  const [week, setWeek] = useState<string>();
  const go = (q = '') => navigate(`/demands/${d.demandId}/change${q}`);

  if (d.actions.recall) {
    const takeBack = async () => {
      try {
        await recall.mutateAsync({ demandId: d.demandId, commandId: newCommandId(), rowVer: d.rowVer, comment: why });
        setTaking(false);
        await Promise.all([utils.demand.invalidate(), utils.work.invalidate()]);
        message.success(`${d.demandNo} is a draft again: change it and submit it again`);
      } catch (err) {
        message.error(errorText(err));
      }
    };
    return (
      <Card size="small" title="Need a change?" styles={{ body: { paddingBlock: 8 } }}>
        <Choice icon={<RollbackOutlined />} button="Take back to change…" onClick={() => { setWhy(''); setTaking(true); }}
          text="Procurement has not accepted it yet: take it back as a draft, change it, and submit it again (next version). It leaves Procurement's list until then." />
        <Modal open={taking} title={`Take ${d.demandNo} back to change it?`} okText="Take back" okButtonProps={{ loading: recall.isPending }}
          onOk={takeBack} onCancel={() => setTaking(false)} destroyOnClose>
          <Typography.Paragraph type="secondary">It becomes a draft you can edit. Procurement no longer sees it to accept until you submit it again; the comment tells them what is changing.</Typography.Paragraph>
          <Input.TextArea id="recallWhy" rows={3} maxLength={2000} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="What will change (optional)" />
        </Modal>
      </Card>
    );
  }
  if (!d.actions.changeContainers && !d.actions.notSourced && !d.actions.merge && !d.actions.createRfq) return null;

  return (
    <>
      {d.actions.changeContainers && (
        <Card size="small" title="Need a change?" styles={{ body: { paddingBlock: 8 } }}>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Typography.Text type="secondary">This demand is accepted, so it is no longer edited directly. Ask Procurement for a change: nothing changes until they approve it.</Typography.Text>
            <Choice icon={<EditOutlined />} button="Change containers" onClick={() => go()}
              text="More or fewer containers, a new container group or week, a group removed, or a different make-up." />
            <Choice icon={<StopOutlined />} button="Cancel week" onClick={() => week && go(`?cancel=${week}`)}
              text="Cancel every container of one ETD week."
              extra={<Select size="middle" placeholder="Week" value={week} onChange={setWeek} style={{ flex: 1 }} aria-label="Week to cancel"
                options={weeks.map((w) => ({ value: w, label: weekLabel(w) }))} />} />
            <Choice icon={<DeleteOutlined />} button="Cancel whole demand" danger onClick={() => go('?cancel=all')}
              text="Cancel all containers of all weeks (quantity already awarded to a supplier cannot be cancelled)." />
          </Space>
        </Card>
      )}
      {(d.actions.notSourced || d.actions.merge || d.actions.createRfq) && (
        <Card size="small" title="Procurement" styles={{ body: { paddingBlock: 8 } }}>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {d.actions.createRfq && (
              <Choice icon={<FileSearchOutlined />} button="Create RFQ…" onClick={() => navigate(`/rfqs/new?demand=${d.demandId}`)}
                text="Ask suppliers for prices on this demand's Open quantity (suppliers of the right origin, ranked by what they supplied to us)." />
            )}
            {d.actions.notSourced && (
              <Choice icon={<StopOutlined />} button="Not sourced…" onClick={() => navigate(`/demands/${d.demandId}/not-sourced`)}
                text="Quantity that cannot be bought — Sales decides whether to drop it." />
            )}
            {d.actions.merge && (
              <Choice icon={<MergeCellsOutlined />} button="Merge another demand into this…" onClick={() => navigate(`/demands/${d.demandId}/merge`)}
                text="Move weeks (or a whole demand) of the same company into this one, to source them together. Can be undone while the quantity is still Open." />
            )}
          </Space>
        </Card>
      )}
    </>
  );
}
