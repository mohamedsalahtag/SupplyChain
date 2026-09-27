import { useState } from 'react';
import { Alert, App, Button, Card, Col, Input, Modal, Row, Space, Statistic, Typography } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { trpc } from '../../lib/trpc';

/**
 * Configuration → Start over: purge every workflow record (demands, RFQs, awards, handoffs, PO drafts, change requests,
 * work items, comments, attachments…) to test again from a clean slate. Users, settings and the SAP copies stay.
 */
export function PurgeSection() {
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const preview = trpc.ops.purgePreview.useQuery();
  const purge = trpc.ops.purge.useMutation();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const d = preview.data;
  const total = d?.deletes.reduce((s, x) => s + x.count, 0) ?? 0;

  const onPurge = async () => {
    try {
      const r = await purge.mutateAsync({ confirm: 'PURGE' });
      setOpen(false);
      setTyped('');
      message.success(`All workflow data purged (${r.deleted.find((x) => x.label === 'Demands')?.count ?? 0} demands). The next demand is D-000001.`);
      await utils.invalidate();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Card size="small" title="Start over — purge all workflow data" loading={preview.isPending}>
        {preview.error && <Alert type="error" showIcon message={preview.error.message} />}
        {d && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Paragraph style={{ margin: 0 }}>
              For test servers: deletes every demand and everything that came from it, so testing can start again from a clean slate.
              Numbers start again at <b>D-000001</b>, <b>RFQ-000001</b> and so on — except PO draft numbers (<b>POD-…</b>), which continue because
              SAP keeps them as the PO reference. Works only on a server with <b>ALLOW_PURGE=true</b>, and not while a PO is on its way to SAP or a sync runs.
              <b>This cannot be undone.</b>
            </Typography.Paragraph>
            <Typography.Text strong>Will be deleted</Typography.Text>
            <Row gutter={[12, 12]}>
              {d.deletes.map((x) => <Col key={x.label} xs={12} md={6} lg={4}><Statistic title={x.label} value={x.count} valueStyle={{ fontSize: 18, color: x.count ? '#cf1322' : undefined }} /></Col>)}
            </Row>
            <Typography.Text strong>Kept</Typography.Text>
            <Typography.Text type="secondary">
              {d.keeps.map((x) => `${x.label} (${x.count.toLocaleString('en-GB')})`).join(' · ')} · roles and permissions · companies and user companies · reason codes ·
              origins and supplier origins · shipping-term lists · all settings and connections · the system work items (sync failed, origins to map) · the security audit log.
            </Typography.Text>
            {!d.allowed && <Alert type="warning" showIcon message={d.refusedBecause ?? 'Purging is refused on this server.'} />}
            <div>
              <Button danger type="primary" icon={<DeleteOutlined />} disabled={!d.allowed || total === 0} onClick={() => setOpen(true)} data-testid="purge-open">
                Purge all workflow data…
              </Button>
              {total === 0 && <Typography.Text type="secondary" style={{ marginInlineStart: 8 }}>Nothing to purge.</Typography.Text>}
            </div>
          </Space>
        )}
      </Card>
      <Modal open={open} title="Purge all workflow data?" onCancel={() => { setOpen(false); setTyped(''); }}
        okText="Purge everything" okButtonProps={{ danger: true, disabled: typed !== 'PURGE', loading: purge.isPending }} onOk={onPurge} destroyOnClose>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Alert type="error" showIcon message={`${total.toLocaleString('en-GB')} records will be deleted for every company, for every user. This cannot be undone.`} />
          <Typography.Text>Type <b>PURGE</b> to confirm.</Typography.Text>
          <Input id="purgeConfirm" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="PURGE" autoComplete="off" />
        </Space>
      </Modal>
    </Space>
  );
}
