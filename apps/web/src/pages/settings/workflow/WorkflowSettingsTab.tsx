import { useEffect, useState } from 'react';
import { App, Button, Card, Form, Input, InputNumber, Space, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { P } from '@supplychain/shared';
import { useCan } from '../../../lib/auth';
import type { RouterOutputs } from '../../../lib/format';
import { trpc } from '../../../lib/trpc';

type Settings = RouterOutputs['workflowSetup']['settings']['settings'];
type Increment = { unit: string; value: string };

/** Configuration → Workflow (spec 11): due times and limits. */
export function WorkflowSettingsTab() {
  const { message } = App.useApp();
  const can = useCan();
  const utils = trpc.useUtils();
  const data = trpc.workflowSetup.settings.useQuery();
  const save = trpc.workflowSetup.saveSettings.useMutation();
  const editable = can(P.configWfSettingsEdit);
  const [s, setS] = useState<Settings | null>(null);
  const [increments, setIncrements] = useState<Increment[]>([]);

  useEffect(() => {
    if (!data.data) return;
    setS(data.data.settings);
    setIncrements(Object.entries(data.data.settings.minIncrement).map(([unit, value]) => ({ unit, value })));
  }, [data.data]);

  if (!s || !data.data) return <Card size="small" loading />;

  const setNum = (key: 'agingWeeksBeforeEtd' | 'masterDataMaxAgeHours' | 'historyLookbackMonths' | 'attachmentMaxMb') => (v: number | null) =>
    setS({ ...s, [key]: v ?? s[key] });

  const onSave = async () => {
    const minIncrement = Object.fromEntries(increments.filter((i) => i.unit.trim()).map((i) => [i.unit.trim().toUpperCase(), i.value.trim()]));
    try {
      await save.mutateAsync({ settings: { ...s, minIncrement }, version: data.data.version });
      message.success('Workflow settings saved');
      await utils.workflowSetup.settings.invalidate();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  const row = (label: string, control: React.ReactNode, hint?: string) => (
    <Form.Item label={label} extra={hint} style={{ marginBottom: 10 }}>{control}</Form.Item>
  );

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Card size="small" title="Due times (hours; blank = no due date)">
        <Form layout="horizontal" labelCol={{ flex: '260px' }} labelAlign="left" colon={false} disabled={!editable}>
          {data.data.itemTypes.map((t) =>
            row(t.label, (
              <InputNumber id={`due-${t.key}`} min={1} max={2160} value={s.dueHours[t.key] ?? null} placeholder="none" style={{ width: 120 }}
                onChange={(v) => setS({ ...s, dueHours: { ...s.dueHours, [t.key]: v ?? null } })} />
            ), t.category === 'EXCEPTION' ? 'Exception' : undefined),
          )}
          <Typography.Text type="secondary">More work types appear here as later stages add them.</Typography.Text>
        </Form>
      </Card>
      <Card size="small" title="Limits">
        <Form layout="horizontal" labelCol={{ flex: '260px' }} labelAlign="left" colon={false} disabled={!editable}>
          {row('Open-quantity ageing alert', <InputNumber id="agingWeeks" min={0} max={52} value={s.agingWeeksBeforeEtd} onChange={setNum('agingWeeksBeforeEtd')} addonAfter="weeks before ETD" />)}
          {row('Master data maximum age', <InputNumber id="mdMaxAge" min={1} max={720} value={s.masterDataMaxAgeHours} onChange={setNum('masterDataMaxAgeHours')} addonAfter="hours" />, 'PO submission is blocked when a sync is older than this.')}
          {row('Purchase history look-back', <InputNumber id="lookback" min={1} max={120} value={s.historyLookbackMonths} onChange={setNum('historyLookbackMonths')} addonAfter="months" />)}
          {row('Attachment size limit', <InputNumber id="attMax" min={1} max={100} value={s.attachmentMaxMb} onChange={setNum('attachmentMaxMb')} addonAfter="MB" />)}
          {row('Minimum quantity increment', (
            <Space direction="vertical" size={4}>
              {increments.map((inc, i) => (
                <Space key={i}>
                  <Input placeholder="Unit" value={inc.unit} maxLength={10} style={{ width: 90 }}
                    onChange={(e) => setIncrements(increments.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))} />
                  <Input placeholder="e.g. 1 or 0.001" value={inc.value} style={{ width: 120 }}
                    onChange={(e) => setIncrements(increments.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                  <Button icon={<DeleteOutlined />} onClick={() => setIncrements(increments.filter((_, j) => j !== i))} />
                </Space>
              ))}
              <Button icon={<PlusOutlined />} onClick={() => setIncrements([...increments, { unit: '', value: '1' }])}>Add unit</Button>
            </Space>
          ), 'Quantities must be a multiple of this, per unit of measure (e.g. CTN = whole cartons).')}
        </Form>
      </Card>
      {editable && <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={onSave}>Save</Button>}
    </Space>
  );
}
