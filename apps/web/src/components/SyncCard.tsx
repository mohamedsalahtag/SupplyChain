import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, App, Button, Card, Descriptions, Divider, Space } from 'antd';
import { DeleteOutlined, SyncOutlined } from '@ant-design/icons';
import { trpc } from '../lib/trpc';
import { formatDateTime, syncSummary } from '../lib/format';

type Source = 'sap.materials' | 'sap.suppliers' | 'sap.purchaseOrders';
type StartResult = { started: true; runId: number } | { started: false; reason: string };
type Notice = { type: 'success' | 'error' | 'warning'; message: string; description?: string } | null;

type Props = {
  title: string;
  source: Source;
  /** Starts the sync on the server; `full` is passed only by the extra "Re-sync everything" button. */
  start: (full: boolean) => Promise<StartResult>;
  confirmText: string;
  /** Word for RowsMarkedMissing, e.g. 'marked "Not in SAP"' or 'removed'. */
  missingLabel?: string;
  /** Why Sync now can't be pressed yet (e.g. nothing chosen), or null. */
  blockedReason?: string | null;
  /** Offer "Re-sync everything" (full: true) next to Sync now. */
  offerFull?: { label: string; confirmText: string };
  /** Offer the red "Delete all and sync fresh" button, which starts its own run. */
  offerFresh?: { confirmText: string; start: () => Promise<StartResult> };
  extraInfo?: ReactNode;
  /** Called when a run this card started has finished, to refresh related data. */
  onFinished?: () => void;
};

/** Last result + Sync now for one SAP source. Shared by every sync in Configuration. */
export function SyncCard({ title, source, start, confirmText, missingLabel, blockedReason, offerFull, offerFresh, extraInfo, onFinished }: Props) {
  const { modal } = App.useApp();
  const [notice, setNotice] = useState<Notice>(null);
  const [starting, setStarting] = useState(false);
  const watchedRunId = useRef<number | null>(null);
  const status = trpc.sync.status.useQuery({ source }, { refetchInterval: (q) => (q.state.data?.running ? 2000 : false) });

  const last = status.data?.last;
  const running = status.data?.running;

  // When the run this card started finishes, show its result.
  useEffect(() => {
    if (!last || last.SyncRunId !== watchedRunId.current) return;
    watchedRunId.current = null;
    setNotice(
      last.Status === 'Succeeded'
        ? { type: 'success', message: 'Sync finished', description: [syncSummary(last, missingLabel), last.Message].filter(Boolean).join('. ') }
        : { type: 'error', message: 'Sync failed', description: last.Message ?? undefined },
    );
    onFinished?.();
  }, [last, missingLabel, onFinished]);

  const run = async (starter: () => Promise<StartResult>) => {
    setNotice(null);
    setStarting(true);
    const r = await starter().catch((err: Error) => ({ started: false as const, reason: err.message }));
    setStarting(false);
    if (r.started) watchedRunId.current = Number(r.runId);
    else setNotice({ type: 'warning', message: 'Sync not started', description: r.reason });
    await status.refetch();
  };

  const confirm = (full: boolean) =>
    modal.confirm({
      title: full ? offerFull!.label + '?' : `${title}: sync now?`,
      content: full ? offerFull!.confirmText : confirmText,
      okText: full ? offerFull!.label : 'Sync now',
      onOk: () => run(() => start(full)),
    });

  const confirmFresh = () =>
    modal.confirm({
      title: `${title}: delete all and sync fresh?`,
      content: offerFresh!.confirmText,
      okText: 'Delete all and sync',
      okButtonProps: { danger: true },
      onOk: () => run(offerFresh!.start),
    });

  return (
    <Card size="small" title={title}>
      <Descriptions
        column={1}
        size="small"
        items={[
          { label: 'Last sync', children: last ? `${formatDateTime(last.FinishedAt)} · by ${last.StartedBy} · ${last.Status}` : 'Never' },
          { label: 'Result', children: last ? (last.Status === 'Succeeded' ? syncSummary(last, missingLabel) : last.Message) : '—' },
          ...(last?.Status === 'Succeeded' && last.Message ? [{ label: 'Note', children: last.Message }] : []),
          { label: 'Runs', children: 'Only when someone clicks Sync now. Nothing runs automatically.' },
        ]}
      />
      {extraInfo}
      <Divider style={{ margin: '8px 0' }} />
      <Space wrap>
        <Button type="primary" icon={<SyncOutlined spin={!!running} />} disabled={!!running || !!blockedReason} loading={starting} onClick={() => confirm(false)}>
          {running ? 'Syncing…' : 'Sync now'}
        </Button>
        {offerFull && (
          <Button disabled={!!running || !!blockedReason} onClick={() => confirm(true)}>
            {offerFull.label}
          </Button>
        )}
        {offerFresh && (
          <Button danger icon={<DeleteOutlined />} disabled={!!running || !!blockedReason} onClick={confirmFresh}>
            Delete all and sync fresh
          </Button>
        )}
      </Space>
      {blockedReason && <Alert type="warning" showIcon style={{ marginTop: 10 }} message={blockedReason} />}
      {running && (
        <Alert type="info" showIcon style={{ marginTop: 10 }}
          message={`Reading from SAP… (started by ${running.StartedBy} at ${formatDateTime(running.StartedAt)})`} />
      )}
      {notice && <Alert {...notice} showIcon closable onClose={() => setNotice(null)} style={{ marginTop: 10 }} />}
    </Card>
  );
}
