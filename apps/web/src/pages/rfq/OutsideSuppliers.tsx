import { useEffect, useRef, useState } from 'react';
import type { RefSelectProps } from 'antd/es/select';
import { Alert, Button, Select, Space, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, UserAddOutlined } from '@ant-design/icons';
import { trpc } from '../../lib/trpc';

export type Outside = { supplierCode: string; name: string; country: string; adds: string[] };

/**
 * RFQ builder step 3 (spec 18 addition): invite a supplier that is not on the shortlist — typically a new supplier whose
 * first contact is this RFQ. Any supplier in SAP that is usable for the company; the origins it lacks are recorded for it.
 */
export function OutsideSuppliers({ demandId, lineIds, value, onChange, shortlisted }: {
  demandId: string; lineIds: string[]; value: Outside[]; onChange: (v: Outside[]) => void; shortlisted: string[];
}) {
  const [open, setOpen] = useState(value.length > 0);
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const select = useRef<RefSelectProps>(null);
  useEffect(() => { const t = setTimeout(() => setQ(typed), 300); return () => clearTimeout(t); }, [typed]);
  const search = trpc.rfq.searchSuppliers.useQuery({ demandId, lineIds, q }, { enabled: open && q.trim().length >= 2, placeholderData: (p) => p });
  const rows = (search.data?.rows ?? []).filter((r) => !value.some((v) => v.supplierCode === r.supplierCode));

  if (!open) {
    return <Button icon={<UserAddOutlined />} onClick={() => setOpen(true)}>Add a supplier not on the list…</Button>;
  }
  return (
    <div style={{ borderTop: '1px dashed #d9d9d9', paddingTop: 10 }}>
      <Typography.Text strong>Suppliers not on the list</Typography.Text>{' '}
      <Typography.Text type="secondary">e.g. a new supplier whose first contact is this RFQ. It must be in SAP (new in SAP? run the suppliers sync first), not blocked, and set up for the company.</Typography.Text>
      <div style={{ margin: '8px 0' }}>
        <Select ref={select} id="outsideSupplier" showSearch filterOption={false} style={{ width: '100%', maxWidth: 560 }} value={null as string | null}
          placeholder="Search a supplier by code or name (2+ letters)" onSearch={setTyped} loading={search.isFetching} aria-label="Search a supplier not on the list"
          notFoundContent={typed.trim().length < 2 ? 'Type at least 2 letters' : search.isFetching ? 'Searching…' : 'No supplier in SAP matches'}
          onChange={(code: string) => {
            const r = rows.find((x) => x.supplierCode === code);
            if (r && !r.problem) onChange([...value, { supplierCode: r.supplierCode, name: r.name, country: r.country, adds: r.adds }]);
            setTyped('');
            select.current?.blur(); // close the list: the pick shows in the table below
          }}
          options={rows.map((r) => ({
            value: r.supplierCode, disabled: !!r.problem || shortlisted.includes(r.supplierCode),
            label: (
              <Space size={6} wrap>
                <span>{r.supplierCode} · {r.name}</span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{[r.country, r.city].filter(Boolean).join(' · ')}{r.origins.length ? ` · supplies ${r.origins.join(', ')}` : ' · no origin yet'}</Typography.Text>
                {r.problem && <Tag color="red">{r.problem}</Tag>}
                {!r.problem && shortlisted.includes(r.supplierCode) && <Tag>already on the list above</Tag>}
              </Space>
            ),
          }))} />
      </div>
      {value.length > 0 && (
        <Table<Outside> size="small" bordered pagination={false} rowKey="supplierCode" dataSource={value} tableLayout="fixed" columns={[
          { title: 'Supplier', key: 's', width: 300, ellipsis: true, render: (_: unknown, r) => <><Tag color="purple">first contact</Tag>{r.supplierCode} · {r.name}</> },
          { title: 'When the RFQ is created', key: 'a', render: (_: unknown, r) => (r.adds.length
            ? <>recorded as supplying <b>{r.adds.join(', ')}</b> (Configuration → Supplier origins, source “RFQ”)</>
            : <Typography.Text type="secondary">already supplies these origins</Typography.Text>) },
          { title: '', key: 'x', width: 50, render: (_: unknown, r) => <Button type="text" size="small" icon={<DeleteOutlined />} aria-label={`Remove ${r.name}`} onClick={() => onChange(value.filter((v) => v.supplierCode !== r.supplierCode))} /> },
        ]} />
      )}
      {search.error && <Alert type="error" showIcon message={search.error.message} style={{ marginTop: 8 }} />}
    </div>
  );
}
