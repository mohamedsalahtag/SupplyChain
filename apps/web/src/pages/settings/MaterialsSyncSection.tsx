import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Descriptions, Divider } from 'antd';
import { SyncOutlined } from '@ant-design/icons';
import { trpc } from '../../lib/trpc';
import { formatDateTime, syncSummary } from '../../lib/format';

type Notice = { type: 'success' | 'error' | 'warning'; message: string; description?: string } | null;

/** Configuration → Materials sync: last result and the Sync now button. Spec 02. */
export function MaterialsSyncSection() {
  const { modal } = App.useApp();
  const utils = trpc.useUtils();
  const [notice, setNotice] = useState<Notice>(null);
  const watchedRunId = useRef<number | null>(null);

  const connection = trpc.settings.getSap.useQuery();
  const status = trpc.materials.syncStatus.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  });
  const startSync = trpc.materials.startSync.useMutation();

  // When the run this page started finishes, show its result and refresh the Materials data.
  const last = status.data?.last;
  useEffect(() => {
    if (!last || last.SyncRunId !== watchedRunId.current) return;
    watchedRunId.current = null;
    setNotice(
      last.Status === 'Succeeded'
        ? { type: 'success', message: 'Sync finished', description: [syncSummary(last), last.Message].filter(Boolean).join('. ') }
        : { type: 'error', message: 'Sync failed — nothing was changed', description: last.Message ?? undefined },
    );
    void utils.materials.list.invalidate();
    void utils.materials.filterOptions.invalidate();
  }, [last, utils]);

  const runSync = async () => {
    setNotice(null);
    const r = await startSync.mutateAsync().catch((err: Error) => ({ started: false as const, reason: err.message }));
    if (r.started) {
      watchedRunId.current = Number(r.runId);
    } else {
      setNotice({ type: 'warning', message: 'Sync not started', description: r.reason });
    }
    await status.refetch();
  };

  const confirmSync = () =>
    modal.confirm({
      title: 'Copy materials from SAP now?',
      content:
        'New materials are added and changed ones updated. Materials SAP no longer returns are marked "Not in SAP" — nothing is deleted.',
      okText: 'Sync now',
      onOk: runSync,
    });

  const running = status.data?.running;

  return (
    <Card size="small" title="Materials sync">
      <Descriptions
        column={1}
        size="small"
        items={[
          { label: 'Last sync', children: last ? `${formatDateTime(last.FinishedAt)} · by ${last.StartedBy} · ${last.Status}` : 'Never' },
          { label: 'Result', children: last ? (last.Status === 'Succeeded' ? syncSummary(last) : last.Message) : '—' },
          { label: 'Runs', children: 'Only when someone clicks Sync now. Nothing runs automatically.' },
        ]}
      />
      <Divider style={{ margin: '8px 0' }} />
      <Button type="primary" icon={<SyncOutlined spin={!!running} />} disabled={!!running || !connection.data}
        loading={startSync.isPending} onClick={confirmSync}>
        {running ? 'Syncing…' : 'Sync now'}
      </Button>
      {!connection.isPending && !connection.data && (
        <Alert type="warning" showIcon style={{ marginTop: 10 }} message="Save the SAP connection first (SAP connection tab)." />
      )}
      {running && (
        <Alert type="info" showIcon style={{ marginTop: 10 }}
          message={`Reading materials from SAP… (started by ${running.StartedBy} at ${formatDateTime(running.StartedAt)})`}
          description="Nothing is saved until every page has been read." />
      )}
      {notice && <Alert {...notice} showIcon closable onClose={() => setNotice(null)} style={{ marginTop: 10 }} />}
    </Card>
  );
}
