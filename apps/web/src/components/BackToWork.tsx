import { Typography } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { Link, useSearchParams } from 'react-router-dom';

/** Adds ?from=<My work tab> to a link, so the opened screen can offer the way back (spec 10). */
export function withFrom(link: string, from: string): string {
  return `${link}${link.includes('?') ? '&' : '?'}from=${encodeURIComponent(from)}`;
}

/** "← Back to My work", shown only when the screen was opened from My work. */
export function BackToWork() {
  const [params] = useSearchParams();
  const from = params.get('from');
  if (!from || !from.startsWith('/work')) return null;
  return (
    <Link to={from}>
      <Typography.Text type="secondary"><ArrowLeftOutlined /> Back to My work</Typography.Text>
    </Link>
  );
}
