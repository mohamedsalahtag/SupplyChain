import { useCallback } from 'react';
import { SyncCard } from '../../components/SyncCard';
import { trpc } from '../../lib/trpc';

/** Configuration → Materials sync: last result and Sync now. Spec 02. */
export function MaterialsSyncSection() {
  const utils = trpc.useUtils();
  const connection = trpc.settings.getSap.useQuery();
  const start = trpc.materials.startSync.useMutation();
  const onFinished = useCallback(() => {
    void utils.materials.list.invalidate();
    void utils.materials.filterOptions.invalidate();
  }, [utils]);

  return (
    <SyncCard
      title="Materials sync"
      source="sap.materials"
      start={() => start.mutateAsync()}
      confirmText='New materials are added and changed ones updated. Materials SAP no longer returns are marked "Not in SAP" — nothing is deleted.'
      blockedReason={!connection.isPending && !connection.data ? 'Save the SAP connection first (SAP connection tab).' : null}
      onFinished={onFinished}
    />
  );
}
