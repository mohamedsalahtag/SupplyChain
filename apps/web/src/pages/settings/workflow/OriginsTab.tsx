import { useMemo, useState } from 'react';
import { App, Checkbox, Select, Tag, Typography } from 'antd';
import { P } from '@supplychain/shared';
import { AppTable, type AppColumn } from '../../../components/AppTable';
import { useCan } from '../../../lib/auth';
import type { RouterOutputs } from '../../../lib/format';
import { trpc } from '../../../lib/trpc';
import { useTablePrefs } from '../../../lib/useTablePrefs';

type Row = RouterOutputs['workflowSetup']['origins'][number];
const NOT_A_COUNTRY = '__none__';

const SOURCE_TAG: Record<Row['Source'], { color: string; label: string }> = {
  Auto: { color: 'blue', label: 'Auto' },
  Manual: { color: 'green', label: 'Manual' },
  NotCountry: { color: 'default', label: 'Not a country' },
  Unmatched: { color: 'warning', label: 'Unmatched' },
};

/** Configuration → Origins (spec 11): SAP material origin names → country codes (a supplier's origin is its SAP country). */
export function OriginsTab() {
  const { message } = App.useApp();
  const can = useCan();
  const utils = trpc.useUtils();
  const prefs = useTablePrefs('wf-origins');
  const [page, setPage] = useState(1);
  const [unmatchedOnly, setUnmatchedOnly] = useState(false);
  const list = trpc.workflowSetup.origins.useQuery({ unmatchedOnly });
  const countries = trpc.workflowSetup.countries.useQuery(undefined, { staleTime: Infinity });
  const save = trpc.workflowSetup.setOrigin.useMutation();
  const editable = can(P.configWfOriginsEdit);

  const options = useMemo(
    () => [{ value: NOT_A_COUNTRY, label: 'Not a country' }, ...(countries.data ?? []).map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))],
    [countries.data],
  );

  const choose = async (r: Row, value: string) => {
    try {
      await save.mutateAsync({ originName: r.OriginName, countryCode: value === NOT_A_COUNTRY ? null : value, rowVer: r.RowVer });
      message.success(`"${r.OriginName || '(blank)'}" saved`);
      await Promise.all([utils.workflowSetup.origins.invalidate(), utils.work.invalidate()]);
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  const unmatched = (list.data ?? []).filter((r) => r.Source === 'Unmatched').length;
  const columns: AppColumn<Row>[] = [
    { title: 'Origin name (SAP)', key: 'OriginName', width: 170, render: (_: unknown, r) => r.OriginName || <Typography.Text type="secondary">(blank)</Typography.Text> },
    { title: 'Materials', key: 'MaterialCount', width: 80, align: 'right', render: (_: unknown, r) => r.MaterialCount.toLocaleString('en-GB') },
    {
      title: 'Country', key: 'CountryCode', width: 260, ellipsis: false,
      render: (_: unknown, r) =>
        editable ? (
          <Select size="small" showSearch optionFilterProp="label" style={{ width: '100%' }} placeholder="— choose —" options={options}
            value={r.Source === 'NotCountry' ? NOT_A_COUNTRY : (r.CountryCode ?? undefined)} onChange={(v: string) => choose(r, v)} disabled={save.isPending} />
        ) : (
          r.CountryCode ? `${r.CountryCode} · ${r.CountryName}` : '—'
        ),
    },
    { title: 'Source', key: 'Source', width: 110, render: (_: unknown, r) => <Tag color={SOURCE_TAG[r.Source].color}>{SOURCE_TAG[r.Source].label}</Tag> },
  ];

  return (
    <AppTable<Row>
      prefs={prefs}
      itemName="origin names"
      rowKey="OriginName"
      columns={columns}
      dataSource={list.data}
      loading={list.isFetching}
      page={page}
      total={list.data?.length ?? 0}
      onPageChange={setPage}
      toolbar={
        <>
          <Checkbox id="unmatchedOnly" checked={unmatchedOnly} onChange={(e) => { setUnmatchedOnly(e.target.checked); setPage(1); }}>Unmatched only</Checkbox>
          <Typography.Text type="secondary">
            Names are matched automatically after each materials sync; a choice made here is never overwritten.
            {!unmatchedOnly && unmatched > 0 && ` ${unmatched} still need a choice.`}
          </Typography.Text>
        </>
      }
    />
  );
}
