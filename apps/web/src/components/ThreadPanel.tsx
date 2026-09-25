import { useState } from 'react';
import { App, Button, Empty, Input, List, Space, Tag, Typography } from 'antd';
import { formatDateTime } from '../lib/format';
import { errorText } from '../lib/workflow';

export type ThreadEntry = { entryId: string; kind: string; body: string; correctsEntryId: string | null; author: string; createdAt: string };

const KIND: Record<string, { label: string; color: string } | undefined> = {
  SYSTEM: { label: 'System', color: 'default' },
  DECISION: { label: 'Decision', color: 'blue' },
  CLARIFICATION: { label: 'Clarification', color: 'orange' },
};

/** The conversation of one business object. Entries cannot be edited; a correction is a new entry. */
export function ThreadPanel({ entries, loading, canAdd, onAdd }: { entries: ThreadEntry[] | undefined; loading: boolean; canAdd: boolean; onAdd: (body: string) => Promise<unknown> }) {
  const { message } = App.useApp();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const add = async () => {
    setSaving(true);
    try {
      await onAdd(text.trim());
      setText('');
    } catch (err) {
      message.error(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <List
        size="small"
        bordered
        loading={loading}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No comments yet" /> }}
        dataSource={entries ?? []}
        renderItem={(e) => (
          <List.Item>
            <Space direction="vertical" size={0} style={{ width: '100%' }}>
              <Space size={6} wrap>
                <Typography.Text strong>{e.author}</Typography.Text>
                <Typography.Text type="secondary">{formatDateTime(e.createdAt)}</Typography.Text>
                {KIND[e.kind] && <Tag color={KIND[e.kind]!.color}>{KIND[e.kind]!.label}</Tag>}
                {e.correctsEntryId && <Tag>Correction</Tag>}
              </Space>
              <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>{e.body}</Typography.Text>
            </Space>
          </List.Item>
        )}
      />
      {canAdd && (
        <Space.Compact style={{ width: '100%' }}>
          <Input.TextArea id="newComment" rows={2} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment" />
          <Button type="primary" disabled={!text.trim()} loading={saving} onClick={add} style={{ height: 'auto' }}>Add</Button>
        </Space.Compact>
      )}
      {canAdd && <Typography.Text type="secondary">Comments cannot be edited; to correct one, add a new comment.</Typography.Text>}
    </Space>
  );
}
