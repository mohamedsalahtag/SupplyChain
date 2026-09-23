import { Card, Space, Tag, Typography } from 'antd';
import { trpc } from '../lib/trpc';

export function HomePage() {
  const health = trpc.health.useQuery();

  const status = health.isPending ? (
    <Tag>Checking…</Tag>
  ) : health.error ? (
    <Tag color="red">API unreachable</Tag>
  ) : health.data.database === 'connected' ? (
    <Tag color="green">Connected</Tag>
  ) : (
    <Tag color="red">Error: {health.data.message}</Tag>
  );

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        Home
      </Typography.Title>
      <Card size="small" title="System status" style={{ maxWidth: 420 }}>
        <Space>
          <Typography.Text>Database:</Typography.Text>
          {status}
        </Space>
      </Card>
    </Space>
  );
}
