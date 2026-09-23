import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, App, Button, Card, Checkbox, Space, Typography } from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { formatDateTime, formatNumber } from '../lib/format';

type CodeCounts = { codes: { code: string; count: number }[]; checkedAt: string } | null | undefined;

type Props = {
  title: string;
  /** What the codes are, e.g. "Supplier groups". */
  label: string;
  available: CodeCounts;
  chosen: string[] | undefined;
  loading: boolean;
  canEdit: boolean;
  refreshing: boolean;
  saving: boolean;
  onRefresh: () => Promise<unknown>;
  onSave: (codes: string[]) => Promise<unknown>;
  /** Extra fields saved with the choice (e.g. a start date), and whether they changed. */
  extra?: ReactNode;
  extraDirty?: boolean;
  extraValid?: boolean;
  note?: ReactNode;
  testId?: string;
};

/** "Load the list from SAP, then choose": codes with counts, checkboxes, Save. Used by every SAP sync. */
export function CodeChoiceCard(p: Props) {
  const { message } = App.useApp();
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => setPicked(p.chosen ?? []), [p.chosen]);

  // Codes SAP offers, plus any chosen code SAP no longer lists (so it can be unticked).
  const options = useMemo(() => {
    const list = p.available?.codes ?? [];
    const extra = (p.chosen ?? []).filter((c) => !list.some((a) => a.code === c)).map((code) => ({ code, count: null as number | null }));
    return [...list.map((a) => ({ code: a.code, count: a.count as number | null })), ...extra];
  }, [p.available, p.chosen]);

  const dirty = [...picked].sort().join() !== [...(p.chosen ?? [])].sort().join() || !!p.extraDirty;
  const fail = (err: unknown) => message.error(err instanceof Error ? err.message : String(err));

  return (
    <Card size="small" title={p.title} loading={p.loading}
      extra={<Typography.Text type="secondary">Applies from the next sync</Typography.Text>}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Space wrap>
          <Typography.Text strong>{p.label}</Typography.Text>
          {p.canEdit && options.length > 0 && (
            <>
              <Typography.Link onClick={() => setPicked(options.map((o) => o.code))}>Select all</Typography.Link>
              <Typography.Link onClick={() => setPicked([])}>None</Typography.Link>
            </>
          )}
        </Space>
        {options.length === 0 ? (
          <Alert type="info" showIcon message="The list has not been loaded from SAP yet. Click “Load list from SAP”, then choose." />
        ) : (
          <div data-testid={p.testId}>
            <Checkbox.Group value={picked} disabled={!p.canEdit} onChange={(v) => setPicked(v as string[])}>
              <Space wrap size={[16, 6]}>
                {options.map((o) => (
                  <Checkbox key={o.code} value={o.code}>
                    {o.code}
                    <Typography.Text type="secondary"> · {o.count == null ? 'not in SAP list' : formatNumber(o.count)}</Typography.Text>
                  </Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
          </div>
        )}
        {p.available && <Typography.Text type="secondary">Counts from SAP, checked {formatDateTime(p.available.checkedAt)}.</Typography.Text>}
        {p.extra}
        {p.note}
        {p.canEdit && (
          <Space wrap>
            <Button type="primary" icon={<SaveOutlined />} disabled={!dirty || picked.length === 0 || p.extraValid === false} loading={p.saving}
              onClick={() => p.onSave(picked).then(() => message.success('Saved. It applies from the next sync.'), fail)}>
              Save
            </Button>
            <Button icon={<ReloadOutlined />} loading={p.refreshing} onClick={() => p.onRefresh().catch(fail)}>
              {p.available ? 'Refresh list from SAP' : 'Load list from SAP'}
            </Button>
          </Space>
        )}
      </Space>
    </Card>
  );
}
