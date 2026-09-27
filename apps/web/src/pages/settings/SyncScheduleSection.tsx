import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Select, Skeleton, Space, Switch, Typography } from 'antd';
import { P } from '@supplychain/shared';
import { useCan } from '../../lib/auth';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { errorText } from '../../lib/workflow';

type Schedule = RouterOutputs['sync']['schedule']['schedule'];
type Source = keyof Schedule;

const SOURCES: { key: Source; label: string; note: string }[] = [
  { key: 'sap.materials', label: 'Materials', note: 'The chosen material types, as the Sync button does.' },
  { key: 'sap.suppliers', label: 'Suppliers', note: 'The chosen supplier groups, as the Sync button does.' },
  { key: 'sap.purchaseOrders', label: 'Purchase orders', note: 'Changes since the last run (the watermark). "Re-sync everything" and a fresh copy stay manual.' },
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, value) => ({ label, value }));
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: h, label: `${String(h).padStart(2, '0')}:00` }));

/** Configuration → SAP → Sync schedule: each SAP sync can run by itself on chosen days and hours (Saudi time). */
export function SyncScheduleSection() {
  const { message } = App.useApp();
  const can = useCan();
  const edit = can(P.configSyncScheduleEdit);
  const utils = trpc.useUtils();
  const q = trpc.sync.schedule.useQuery();
  const save = trpc.sync.saveSchedule.useMutation();
  const [s, setS] = useState<Schedule>();
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (q.data && !dirty) setS(q.data.schedule); }, [q.data, dirty]);

  if (!s || !q.data) return q.error ? <Alert type="error" showIcon message={q.error.message} /> : <Skeleton active />;
  const set = (k: Source, patch: Partial<Schedule[Source]>) => { setS({ ...s, [k]: { ...s[k], ...patch } }); setDirty(true); };
  const onSave = async () => {
    try { await save.mutateAsync(s); setDirty(false); await utils.sync.schedule.invalidate(); message.success('Sync schedule saved'); }
    catch (err) { message.error(errorText(err)); }
  };

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Alert type="info" showIcon message="Times are Saudi time (UTC+3). A scheduled sync starts at the top of each chosen hour, shows in the sync history as started by “Scheduler”, and is skipped when that sync already ran or is running in that hour." />
      {SOURCES.map(({ key, label, note }) => {
        const e = s[key];
        const next = q.data.next[key];
        return (
          <Card key={key} size="small" title={<Space><Switch size="small" checked={e.enabled} disabled={!edit} onChange={(v) => set(key, { enabled: v })} aria-label={`Schedule ${label}`} />{label} sync</Space>}
            extra={<Typography.Text type="secondary">{e.enabled ? (dirty ? 'Save to plan the next run' : next ? `Next run ${formatDateTime(next)}` : 'No run within a week') : 'Off — runs only by hand'}</Typography.Text>}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Space wrap align="center">
                <Typography.Text type="secondary" style={{ display: 'inline-block', width: 50 }}>Days</Typography.Text>
                <Checkbox.Group options={DAYS} value={e.days} disabled={!edit || !e.enabled} onChange={(v) => set(key, { days: v as number[] })} />
                <Button size="small" type="link" disabled={!edit || !e.enabled} onClick={() => set(key, { days: [0, 1, 2, 3, 4] })}>Sun–Thu</Button>
                <Button size="small" type="link" disabled={!edit || !e.enabled} onClick={() => set(key, { days: [0, 1, 2, 3, 4, 5, 6] })}>Every day</Button>
              </Space>
              <Space wrap align="center" style={{ width: '100%' }}>
                <Typography.Text type="secondary" style={{ display: 'inline-block', width: 50 }}>Hours</Typography.Text>
                <Select mode="multiple" allowClear style={{ minWidth: 320, maxWidth: '100%' }} placeholder="Choose one or more hours" options={HOURS} value={e.hours}
                  disabled={!edit || !e.enabled} onChange={(v: number[]) => set(key, { hours: v })} aria-label={`Hours ${label}`} />
              </Space>
              <Typography.Text type="secondary">{note}</Typography.Text>
              {e.enabled && (!e.days.length || !e.hours.length) && <Typography.Text type="danger">Choose at least one day and one hour, or turn it off.</Typography.Text>}
            </Space>
          </Card>
        );
      })}
      {edit && (
        <Space>
          <Button type="primary" disabled={!dirty} loading={save.isPending} onClick={onSave}>Save schedule</Button>
          <Button disabled={!dirty} onClick={() => { setDirty(false); setS(q.data.schedule); }}>Undo changes</Button>
        </Space>
      )}
    </Space>
  );
}
