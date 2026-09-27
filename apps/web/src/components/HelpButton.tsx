import { useRef, useState } from 'react';
import { Button, Modal, Space, Tooltip } from 'antd';
import { DownloadOutlined, FullscreenExitOutlined, FullscreenOutlined, PrinterOutlined, QuestionCircleOutlined } from '@ant-design/icons';

const GUIDE_URL = '/help/user-guide.pdf';

/**
 * The help button beside the user's name (spec 27): opens the user guide PDF in a window that can be downloaded, printed,
 * maximized and closed. The PDF is a static file generated from docs/help/user-guide.html (`npm run help:pdf`).
 */
export function HelpButton() {
  const [open, setOpen] = useState(false);
  const [max, setMax] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

  const print = () => {
    try {
      const w = frame.current?.contentWindow;
      if (w) { w.focus(); w.print(); return; }
    } catch { /* the viewer refused: fall through */ }
    window.open(GUIDE_URL, '_blank', 'noopener');
  };

  return (
    <>
      <Tooltip title="User guide">
        <Button type="text" data-testid="help" aria-label="User guide" icon={<QuestionCircleOutlined />} onClick={() => setOpen(true)} style={{ color: '#fff', marginInlineEnd: 8 }} />
      </Tooltip>
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        destroyOnHidden
        width={max ? '100vw' : 1000}
        style={max ? { top: 0, maxWidth: '100vw', paddingBottom: 0 } : { top: 24 }}
        styles={{ body: { height: max ? 'calc(100vh - 56px)' : '76vh', padding: 0 } }}
        title={
          <Space wrap>
            <span>User guide</span>
            <Button size="small" icon={<DownloadOutlined />} href={GUIDE_URL} download="Supply-Chain-user-guide.pdf">Download</Button>
            <Button size="small" icon={<PrinterOutlined />} onClick={print}>Print</Button>
            <Button size="small" icon={max ? <FullscreenExitOutlined /> : <FullscreenOutlined />} onClick={() => setMax((m) => !m)}>{max ? 'Restore' : 'Maximize'}</Button>
          </Space>
        }>
        <iframe ref={frame} title="User guide" src={`${GUIDE_URL}#view=FitH`} style={{ width: '100%', height: '100%', border: 0, display: 'block' }} />
      </Modal>
    </>
  );
}
