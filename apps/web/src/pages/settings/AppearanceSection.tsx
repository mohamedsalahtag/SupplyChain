import { useEffect, useState } from 'react';
import { App, Button, Card, Segmented, Space, Typography } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { trpc } from '../../lib/trpc';

const SIZES = [10, 11, 12, 13, 14, 15, 16];

/** Configuration section: the font size of the whole app, for every user. Spec 03. */
export function AppearanceSection() {
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const ui = trpc.settings.getUi.useQuery();
  const save = trpc.settings.saveAppearance.useMutation();
  const [fontSize, setFontSize] = useState<number>();

  useEffect(() => {
    if (ui.data) setFontSize(ui.data.fontSize);
  }, [ui.data]);

  const onSave = async () => {
    if (!fontSize) return;
    try {
      await save.mutateAsync({ fontSize });
      await utils.settings.getUi.invalidate(); // re-themes the app at once
      message.success(`Font size set to ${fontSize}`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  const changed = ui.data && fontSize !== ui.data.fontSize;

  return (
    <Card size="small" title="Font size" loading={ui.isPending}
      extra={<Typography.Text type="secondary">Applies to the whole app, for every user</Typography.Text>}>
      <Space direction="vertical" size={10}>
        <Space wrap align="center">
          <Typography.Text>Font size</Typography.Text>
          <Segmented id="fontSize" value={fontSize} onChange={(v) => setFontSize(Number(v))}
            options={SIZES.map((s) => ({ value: s, label: `${s} px` }))} />
          <Button type="primary" icon={<SaveOutlined />} disabled={!changed} loading={save.isPending} onClick={onSave}>
            Save
          </Button>
        </Space>
        <Typography.Text style={{ fontSize }} type="secondary">
          Preview: Banana Cavendish 13kg · Citrus · Easypeeler · 2,806 materials
        </Typography.Text>
      </Space>
    </Card>
  );
}
