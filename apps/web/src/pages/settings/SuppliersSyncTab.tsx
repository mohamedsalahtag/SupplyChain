import { useCallback } from 'react';
import { Space } from 'antd';
import { P } from '@supplychain/shared';
import { CodeChoiceCard } from '../../components/CodeChoiceCard';
import { SyncCard } from '../../components/SyncCard';
import { useCan } from '../../lib/auth';
import { trpc } from '../../lib/trpc';

/** Configuration → Suppliers sync: choose Z supplier groups, then Sync now. Spec 08. */
export function SuppliersSyncTab() {
  const can = useCan();
  const utils = trpc.useUtils();
  const include = trpc.suppliers.include.useQuery();
  const save = trpc.suppliers.saveInclude.useMutation();
  const refresh = trpc.suppliers.refreshGroups.useMutation();
  const start = trpc.suppliers.startSync.useMutation();
  const onFinished = useCallback(() => void utils.suppliers.invalidate(), [utils]);

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {can(P.configSuppliersEdit) && (
        <CodeChoiceCard
          title="Suppliers to copy"
          label="Supplier groups (only groups starting with Z)"
          testId="supplier-groups"
          available={include.data?.available}
          chosen={include.data?.groups}
          loading={include.isPending}
          canEdit
          refreshing={refresh.isPending}
          saving={save.isPending}
          onRefresh={() => refresh.mutateAsync().then(() => utils.suppliers.include.invalidate())}
          onSave={(groups) => save.mutateAsync({ groups }).then(() => utils.suppliers.include.invalidate())}
          note="Suppliers in groups you untick later are kept but marked “Not in SAP”."
        />
      )}
      {can(P.configSuppliersRun) && (
        <SyncCard
          title="Suppliers sync"
          source="sap.suppliers"
          start={() => start.mutateAsync()}
          confirmText="Suppliers in the chosen groups are added or updated (name, country, currency, address, email). Suppliers no longer returned are marked “Not in SAP” — nothing is deleted."
          blockedReason={include.data && include.data.groups.length === 0 ? 'Choose at least one supplier group and save it first.' : null}
          onFinished={onFinished}
        />
      )}
    </Space>
  );
}
