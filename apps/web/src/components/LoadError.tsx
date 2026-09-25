import type { ReactNode } from 'react';
import { Button, Result } from 'antd';
import { isNotFound } from '../lib/workflow';

/** A detail page that could not load: "not found" only when the server says so; anything else shows its message and a retry. */
export function LoadError({ error, what, extra, onRetry }: { error: unknown; what: string; extra?: ReactNode; onRetry?: () => void }) {
  return isNotFound(error)
    ? <Result status="404" title={`${what} not found`} subTitle="It does not exist, or it belongs to a company you do not work for." extra={extra} />
    : <Result status="error" title={`The ${what.toLowerCase()} could not be loaded`} subTitle={error instanceof Error ? error.message : String(error)}
        extra={<>{onRetry && <Button onClick={onRetry}>Try again</Button>}{extra}</>} />;
}
