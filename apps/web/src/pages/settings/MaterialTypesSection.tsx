import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Space, Typography } from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { trpc } from '../../lib/trpc';
import { formatDateTime, formatNumber } from '../../lib/format';

/** Configuration → Materials sync: which SAP material types the sync copies. Spec 02. */
export function MaterialTypesSection() {
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const include = trpc.settings.getMaterialsInclude.useQuery();
  const save = trpc.settings.saveMaterialsInclude.useMutation();
  const refresh = trpc.settings.refreshMaterialTypes.useMutation();
  const [chosen, setChosen] = useState<string[]>([]);

  useEffect(() => {
    if (include.data) setChosen(include.data.materialTypes);
  }, [include.data]);

  // Types SAP offers, plus any chosen type SAP no longer lists (so it can be unticked).
  const options = useMemo(() => {
    const available = include.data?.available?.types ?? [];
    const extra = (include.data?.materialTypes ?? []).filter((t) => !available.some((a) => a.code === t)).map((code) => ({ code, count: null }));
    return [...available.map((a) => ({ code: a.code, count: a.count as number | null })), ...extra];
  }, [include.data]);

  const onRefresh = async () => {
    try {
      await refresh.mutateAsync();
      await utils.settings.getMaterialsInclude.invalidate();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  const onSave = async () => {
    try {
      await save.mutateAsync({ materialTypes: chosen });
      await utils.settings.getMaterialsInclude.invalidate();
      message.success('Material types saved. They apply from the next sync.');
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  const saved = include.data?.materialTypes ?? [];
  const changed = [...chosen].sort().join() !== [...saved].sort().join();

  return (
    <Card size="small" title="Materials to copy" loading={include.isPending}
      extra={<Typography.Text type="secondary">Applies from the next sync</Typography.Text>}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Typography.Text strong>Material types</Typography.Text>
        {options.length === 0 ? (
          <Typography.Text type="secondary">The list of types has not been loaded from SAP yet.</Typography.Text>
        ) : (
          <div data-testid="material-types">
            <Checkbox.Group value={chosen} onChange={(v) => setChosen(v as string[])}>
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
        <Typography.Text type="secondary">
          Counts are all SAP materials of that type
          {include.data?.available ? `, checked ${formatDateTime(include.data.available.checkedAt)}` : ''}. The sync also keeps only
          the fruit and vegetable major categories, and never copies codes that start with a number.
        </Typography.Text>
        {chosen.length === 0 && <Alert type="warning" showIcon message="Choose at least one material type." />}
        <Space wrap>
          <Button type="primary" icon={<SaveOutlined />} disabled={!changed || chosen.length === 0} loading={save.isPending} onClick={onSave}>
            Save
          </Button>
          <Button icon={<ReloadOutlined />} loading={refresh.isPending} onClick={onRefresh}>
            {include.data?.available ? 'Refresh list from SAP' : 'Load list from SAP'}
          </Button>
        </Space>
      </Space>
    </Card>
  );
}
