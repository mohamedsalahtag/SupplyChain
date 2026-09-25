import { useState } from 'react';
import { Alert, App, Button, Input, Select, Space, Tag, Typography } from 'antd';
import { P } from '@supplychain/shared';
import { AppTable, type AppColumn } from '../../../components/AppTable';
import { useCan } from '../../../lib/auth';
import type { RouterOutputs } from '../../../lib/format';
import { trpc } from '../../../lib/trpc';
import { useTablePrefs } from '../../../lib/useTablePrefs';

type Row = RouterOutputs['workflowSetup']['supplierOrigins']['rows'][number];
const SOURCE: Record<string, { color: string; label: string }> = {
  COUNTRY: { color: 'default', label: 'country' },
  HISTORY: { color: 'blue', label: 'history' },
  MANUAL: { color: 'green', label: 'added' },
};

/**
 * Configuration → Supplier origins (spec 18): the origins a supplier can supply —
 * its SAP country, what it supplied to us (PO history) and origins added here.
 */
export function SupplierOriginsTab() {
  const { message } = App.useApp();
  const can = useCan();
  const utils = trpc.useUtils();
  const prefs = useTablePrefs('wf-supplier-origins');
  const [page, setPage] = useState(1);
  const [q, setQ] = useState<string>();
  const [origin, setOrigin] = useState<string>();
  const [adding, setAdding] = useState<Record<string, string | undefined>>({});
  const list = trpc.workflowSetup.supplierOrigins.useQuery({ q, origin, page, pageSize: prefs.pageSize }, { enabled: prefs.ready, placeholderData: (p) => p });
  const countries = trpc.workflowSetup.countries.useQuery(undefined, { staleTime: Infinity });
  const save = trpc.workflowSetup.setSupplierOrigin.useMutation();
  const editable = can(P.supplierOriginsEdit);
  const countryOptions = (countries.data ?? []).map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }));

  const change = async (supplierCode: string, originCode: string, add: boolean) => {
    try {
      await save.mutateAsync({ supplierCode, originCode, add });
      message.success(add ? `${originCode} added to ${supplierCode}` : `${originCode} removed from ${supplierCode}`);
      setAdding({ ...adding, [supplierCode]: undefined });
      await utils.workflowSetup.supplierOrigins.invalidate();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const columns: AppColumn<Row>[] = [
    { title: 'Supplier', key: 'supplier', width: 280, ellipsis: true, render: (_: unknown, r) => `${r.supplierCode} · ${r.name}` },
    {
      title: 'Origins', key: 'origins', width: 420,
      render: (_: unknown, r) => (
        <Space size={4} wrap>
          {r.origins.length === 0 && <Typography.Text type="secondary">none known</Typography.Text>}
          {r.origins.map((o) => (
            <Tag key={`${o.originCode}-${o.source}`} color={SOURCE[o.source].color} closable={editable && o.source === 'MANUAL'}
              onClose={(e) => { e.preventDefault(); void change(r.supplierCode, o.originCode, false); }}>
              {o.originCode} · {SOURCE[o.source].label}
            </Tag>
          ))}
        </Space>
      ),
    },
    ...(editable ? [{
      title: 'Add origin', key: 'add', width: 240,
      render: (_: unknown, r: Row) => (
        <Space.Compact>
          <Select size="small" showSearch style={{ width: 150 }} placeholder="Origin" value={adding[r.supplierCode]} options={countryOptions} optionFilterProp="label"
            onChange={(v: string) => setAdding({ ...adding, [r.supplierCode]: v })} aria-label={`Origin for ${r.supplierCode}`} />
          <Button size="small" disabled={!adding[r.supplierCode]} onClick={() => change(r.supplierCode, adding[r.supplierCode]!, true)}>Add</Button>
        </Space.Compact>
      ),
    } as AppColumn<Row>] : []),
  ];

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Alert type="info" showIcon message="A supplier can supply its SAP country, every origin it has supplied to us (refreshed after each supplier and PO sync) and origins added here. RFQ shortlists and quotes use this list." />
      <AppTable<Row>
        prefs={prefs} itemName="suppliers" rowKey="supplierCode" columns={columns} dataSource={list.data?.rows} loading={!prefs.ready || list.isFetching}
        page={page} total={list.data?.total ?? 0} onPageChange={setPage}
        toolbar={
          <>
            <Input.Search id="soSearch" placeholder="Supplier code or name" allowClear style={{ width: 230 }} onSearch={(v) => { setQ(v.trim() || undefined); setPage(1); }} />
            <Select id="soOrigin" allowClear showSearch placeholder="Origin" style={{ width: 170 }} options={countryOptions} optionFilterProp="label" value={origin} onChange={(v) => { setOrigin(v); setPage(1); }} />
          </>
        }
      />
    </Space>
  );
}
