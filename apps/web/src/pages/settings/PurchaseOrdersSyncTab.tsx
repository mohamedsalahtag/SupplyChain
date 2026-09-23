import { useCallback, useEffect, useState } from 'react';
import { Alert, DatePicker, Space, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { P } from '@supplychain/shared';
import { CodeChoiceCard } from '../../components/CodeChoiceCard';
import { SyncCard } from '../../components/SyncCard';
import { useCan } from '../../lib/auth';
import { formatDateTime } from '../../lib/format';
import { trpc } from '../../lib/trpc';

/** Configuration → Purchase orders sync: Z order types + start date, then Sync now. Spec 09. */
export function PurchaseOrdersSyncTab() {
  const can = useCan();
  const utils = trpc.useUtils();
  const include = trpc.purchaseOrders.include.useQuery();
  const save = trpc.purchaseOrders.saveInclude.useMutation();
  const refresh = trpc.purchaseOrders.refreshTypes.useMutation();
  const start = trpc.purchaseOrders.startSync.useMutation();
  const [startDate, setStartDate] = useState<Dayjs | null>(null);
  const onFinished = useCallback(() => {
    void utils.purchaseOrders.invalidate();
  }, [utils]);

  useEffect(() => {
    if (include.data) setStartDate(include.data.startDate ? dayjs(include.data.startDate) : null);
  }, [include.data]);

  const savedDate = include.data?.startDate ?? null;
  const pickedDate = startDate ? startDate.format('YYYY-MM-DD') : null;
  const ready = !!include.data && include.data.orderTypes.length > 0 && !!include.data.startDate;

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {can(P.configPoEdit) && (
        <CodeChoiceCard
          title="Purchase orders to copy"
          label="Order types (only types starting with Z)"
          testId="po-types"
          available={include.data?.available}
          chosen={include.data?.orderTypes}
          loading={include.isPending}
          canEdit
          refreshing={refresh.isPending}
          saving={save.isPending}
          onRefresh={() => refresh.mutateAsync().then(() => utils.purchaseOrders.include.invalidate())}
          onSave={(orderTypes) => save.mutateAsync({ orderTypes, startDate: pickedDate }).then(() => utils.purchaseOrders.include.invalidate())}
          extraDirty={pickedDate !== savedDate}
          extraValid={!!pickedDate}
          extra={
            <Space wrap>
              <Typography.Text strong>Start date</Typography.Text>
              <DatePicker id="poStartDate" value={startDate} onChange={setStartDate} format="DD MMM YYYY" allowClear={false} />
              <Typography.Text type="secondary">Only orders dated on or after this day.</Typography.Text>
            </Space>
          }
          note={
            <Typography.Text type="secondary">
              Loading the list reads every order’s type from SAP and takes about a minute. Changing the types or the start date makes the next
              sync a full one; orders that no longer fit are then removed from this app.
            </Typography.Text>
          }
        />
      )}
      {can(P.configPoRun) && (
        <SyncCard
          title="Purchase orders sync"
          source="sap.purchaseOrders"
          missingLabel="removed"
          start={(full) => start.mutateAsync({ full })}
          confirmText="Orders changed since the last sync are copied (the first sync copies everything after the start date). Only material lines without a deletion flag are kept."
          offerFull={{ label: 'Re-sync everything', confirmText: 'Re-reads every order after the start date. Takes longer; existing orders are updated in place, never duplicated.' }}
          blockedReason={include.data && !ready ? 'Choose the order types and a start date, and save them first.' : null}
          extraInfo={
            include.data && (
              <Alert type={include.data.watermark ? 'info' : 'warning'} showIcon style={{ marginTop: 6 }}
                message={include.data.watermark
                  ? `Next sync fetches only orders changed since ${formatDateTime(include.data.watermark)} (minus one hour).`
                  : 'Next sync is a full one: every order of the chosen types after the start date.'} />
            )
          }
          onFinished={onFinished}
        />
      )}
    </Space>
  );
}
