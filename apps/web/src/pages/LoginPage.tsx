import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { trpc } from '../lib/trpc';
import { useMe } from '../lib/auth';

type Values = { username: string; password: string };

/** Sign in with the Active Directory account. Spec 05. */
export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const utils = trpc.useUtils();
  const { me } = useMe();
  const ui = trpc.settings.getUi.useQuery(undefined, { staleTime: Infinity });
  const login = trpc.auth.login.useMutation();
  const [error, setError] = useState<string | null>(null);

  // Only return to a page inside this app.
  const next = params.get('next')?.startsWith('/') && !params.get('next')?.startsWith('//') ? params.get('next')! : '/';
  if (me) return <Navigate to={next} replace />;

  const onFinish = async (v: Values) => {
    setError(null);
    try {
      await login.mutateAsync(v);
      await utils.invalidate(); // everything reloads as the signed-in user
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#f0f2f1', paddingInline: 16 }}>
      <Card style={{ width: 360, maxWidth: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <img src={ui.data?.iconDataUrl ?? '/favicon.svg'} alt="" width={36} height={36} style={{ objectFit: 'contain' }} />
          <Typography.Title level={4} style={{ margin: 0 }}>
            {ui.data?.siteName ?? ''}
          </Typography.Title>
        </div>
        <Typography.Paragraph type="secondary">Sign in with your company (Active Directory) account.</Typography.Paragraph>
        <Form<Values> layout="vertical" onFinish={onFinish} requiredMark={false} disabled={login.isPending}>
          <Form.Item label="Username" name="username" rules={[{ required: true, message: 'Enter your username' }]}
            extra="e.g. mohamed.tag or mohamed.tag@sharbatlyfruit.com">
            <Input id="username" prefix={<UserOutlined />} autoComplete="username" autoFocus />
          </Form.Item>
          <Form.Item label="Password" name="password" rules={[{ required: true, message: 'Enter your password' }]}>
            <Input.Password id="password" prefix={<LockOutlined />} autoComplete="current-password" />
          </Form.Item>
          {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
          <Button type="primary" htmlType="submit" block loading={login.isPending}>
            Sign in
          </Button>
        </Form>
      </Card>
    </div>
  );
}
