import { Component, type ReactNode } from 'react';
import { Button, Result } from 'antd';

/** One broken screen must not blank the whole app: shows what happened and a way on. Reset by changing `resetKey` (the route). */
export class ErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidUpdate(prev: { resetKey: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  componentDidCatch(error: Error) { console.error('Screen failed', error); }
  render() {
    if (!this.state.error) return this.props.children;
    return <Result status="error" title="This screen could not be shown" subTitle={this.state.error.message}
      extra={<Button type="primary" onClick={() => window.location.reload()}>Reload</Button>} />;
  }
}
