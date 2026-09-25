import { useState } from 'react';
import { App, Button, Checkbox, Space, Table, Tag, Typography, Upload } from 'antd';
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import { formatDateTime } from '../lib/format';

export type AttachmentRow = {
  attachmentId: string; fileName: string; contentType: string; sizeBytes: number; versionNo: number; isCurrent: boolean;
  supersedesId: string | null; uploadedBy: string; uploadedAt: string;
};

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.xlsx,.xls,.csv,.docx,.doc,.msg,.eml';
const size = (b: number) => (b < 1024 ? `${b} B` : b < 1_048_576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1_048_576).toFixed(1)} MB`);

/** Upload a file to an object; the server checks access, type and size. */
async function upload(entityType: string, entityId: string, file: File, supersedesId?: string) {
  const qs = new URLSearchParams({ entityType, entityId, fileName: file.name, ...(supersedesId ? { supersedesId } : {}) });
  const res = await fetch(`/files/attachments?${qs}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file, credentials: 'same-origin' });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? `Upload failed (${res.status})`);
}

/** Attachments of one business object: versions kept, downloads logged (plan v5 §0.7). */
export function AttachmentsPanel({ entityType, entityId, rows, loading, canUpload, showOld, onShowOld, onChanged }: {
  entityType: string; entityId: string; rows: AttachmentRow[] | undefined; loading: boolean; canUpload: boolean;
  showOld: boolean; onShowOld: (v: boolean) => void; onChanged: () => void;
}) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);

  const send = async (file: File, supersedesId?: string) => {
    setBusy(true);
    try {
      await upload(entityType, entityId, file, supersedesId);
      message.success(`${file.name} uploaded`);
      onChanged();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
    return false;
  };

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap>
        {canUpload && (
          <Upload accept={ACCEPT} showUploadList={false} beforeUpload={(f) => send(f)}>
            <Button icon={<UploadOutlined />} loading={busy}>Upload…</Button>
          </Upload>
        )}
        <Checkbox checked={showOld} onChange={(e) => onShowOld(e.target.checked)}>Show old versions</Checkbox>
        <Typography.Text type="secondary">PDF, images, Excel, Word, email · size limit in Configuration → Workflow · downloads are logged</Typography.Text>
      </Space>
      <Table<AttachmentRow>
        size="small"
        bordered
        rowKey="attachmentId"
        loading={loading}
        pagination={false}
        dataSource={rows}
        locale={{ emptyText: 'No attachments' }}
        columns={[
          { title: 'File', key: 'f', ellipsis: true, render: (_: unknown, r) => <>{r.fileName} {!r.isCurrent && <Tag>Old version</Tag>}</> },
          { title: 'Version', dataIndex: 'versionNo', width: 70 },
          { title: 'Size', key: 's', width: 80, render: (_: unknown, r) => size(r.sizeBytes) },
          { title: 'Uploaded by', dataIndex: 'uploadedBy', width: 150, ellipsis: true },
          { title: 'When', key: 'w', width: 150, render: (_: unknown, r) => formatDateTime(r.uploadedAt) },
          {
            title: '', key: 'a', width: 190,
            render: (_: unknown, r) => (
              <Space size={4}>
                <Button size="small" icon={<DownloadOutlined />} href={`/files/attachments/${r.attachmentId}`}>Download</Button>
                {canUpload && r.isCurrent && (
                  <Upload accept={ACCEPT} showUploadList={false} beforeUpload={(f) => send(f, r.attachmentId)}>
                    <Button size="small">New version…</Button>
                  </Upload>
                )}
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}
