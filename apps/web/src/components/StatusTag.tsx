import { useState, type ReactNode } from 'react';
import { Button, Drawer, Steps, Table, Tag, Tooltip, Typography } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import type { StatusDef } from '../lib/statuses';

/** A status with its explanation on hover (spec 21). */
export function StatusTag({ def, label, chip }: { def: StatusDef | undefined; label?: ReactNode; chip?: string }) {
  if (!def) return null;
  return (
    <Tooltip title={def.tip} overlayStyle={{ maxWidth: 360 }}>
      <span style={{ cursor: 'help', whiteSpace: 'nowrap' }}>
        <Tag color={def.color} style={{ marginInlineEnd: 0 }}>{label ?? def.label}</Tag>
        {chip && <Tag bordered={false} style={{ marginInlineStart: 4, marginInlineEnd: 0, borderRadius: 10, fontSize: 11 }}>{chip}</Tag>}
      </span>
    </Tooltip>
  );
}

/** "What do the statuses mean?" — every status, who has it and what is next (spec 21). */
export function StatusLegend({ title, defs }: { title: string; defs: Record<string, StatusDef> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={<QuestionCircleOutlined />} onClick={() => setOpen(true)}>What do the statuses mean?</Button>
      <Drawer open={open} onClose={() => setOpen(false)} title={title} width={620}>
        <Table size="small" pagination={false} rowKey="label" dataSource={Object.values(defs)} columns={[
          { title: 'Status', key: 's', width: 220, render: (_: unknown, d: StatusDef) => <Tag color={d.color}>{d.label}</Tag> },
          { title: 'What it means', dataIndex: 'tip' },
          { title: 'Who has it', dataIndex: 'who', width: 120 },
        ]} />
      </Drawer>
    </>
  );
}

/** The process steps with the current one highlighted (spec 21, page headers). */
export function ProcessSteps({ steps, current }: { steps: string[]; current: number }) {
  if (current < 0) return null;
  return <Steps size="small" current={Math.min(current, steps.length - 1)} items={steps.map((title) => ({ title }))} style={{ maxWidth: 1100 }} />;
}

/** The status block under a page title: Now / Who has it / Next / History… (spec 21). */
export function StatusBlock({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <div style={{ background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 6, padding: '8px 12px', display: 'grid', gridTemplateColumns: '100px 1fr', gap: '4px 12px', fontSize: 13 }}>
      {rows.filter((r) => r.value !== null && r.value !== undefined && r.value !== '').map((r) => [
        <Typography.Text key={`${r.label}-l`} type="secondary">{r.label}</Typography.Text>,
        <div key={`${r.label}-v`}>{r.value}</div>,
      ])}
    </div>
  );
}
