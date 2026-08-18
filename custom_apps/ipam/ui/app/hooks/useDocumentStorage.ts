import { useEffect, useRef, useState } from 'react';
import { documentsClient } from '@dynatrace-sdk/client-document';
import { functions } from '@dynatrace-sdk/app-utils';
import { getCurrentUserDetails } from '@dynatrace-sdk/app-environment';
import type { Subnet, IpRecord, IpamMutation, IpamMutationResult, IpamMutationResponse, NewSubnet, NewIpRecord } from '../types/ipam';

const DOC_ID = 'my-ipam-data-v1';
const DOC_TYPE = 'my-ipam-data';
const POLL_INTERVAL_MS = 20_000;

interface IpamData {
  subnets: Subnet[];
  ipRecords: IpRecord[];
}

function toBlob(data: IpamData): Blob {
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

// All writes go through the `ipamMutate` app function (see api/ipamMutate.function.ts),
// which validates and stamps createdBy/updatedBy server-side. This hook only ever
// applies the canonical {subnets, ipRecords} a mutation call returns - it never
// writes optimistic local state, so a failed mutation can't silently diverge
// from the server on the next poll.

function extractErrorStatus(e: unknown): number | undefined {
  const cause = (e as { cause?: unknown })?.cause;
  if (cause instanceof Response) return cause.status;
  return (e as { status?: number })?.status;
}

async function extractErrorMessage(e: unknown): Promise<string> {
  const cause = (e as { cause?: unknown })?.cause;
  if (cause instanceof Response) {
    try {
      const body: unknown = await cause.clone().json();
      const msg = (body as { message?: unknown; error?: { message?: unknown } })?.message
        ?? (body as { error?: { message?: unknown } })?.error?.message;
      if (typeof msg === 'string') return msg;
    } catch {
      // response body wasn't JSON (or already consumed) - fall through
    }
  }
  return e instanceof Error ? e.message : String(e);
}

export function useDocumentStorage() {
  const [subnets, setSubnets] = useState<Subnet[]>([]);
  const [ipRecords, setIpRecords] = useState<IpRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  const versionRef = useRef<string>('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMutatingRef = useRef(false);

  useEffect(() => {
    void load();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function fetchAndApply(forceApply = false): Promise<boolean> {
    try {
      const res = await documentsClient.getDocument({ id: DOC_ID, adminAccess: true });
      const newVersion = res.metadata?.version ?? '';
      if (!forceApply && newVersion && newVersion === versionRef.current) return true;

      if (res.metadata) versionRef.current = res.metadata.version;
      if (res.content) {
        const text = await res.content.get('text');
        const data = JSON.parse(text) as IpamData;
        setSubnets(data.subnets ?? []);
        setIpRecords(data.ipRecords ?? []);
      }
      setLastSyncedAt(new Date());
      return true;
    } catch {
      return false;
    }
  }

  function startPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      if (!isMutatingRef.current) void fetchAndApply();
    }, POLL_INTERVAL_MS);
  }

  async function load() {
    try {
      setIsLoading(true);
      setPermissionDenied(false);
      setNeedsSetup(false);

      const res = await documentsClient.getDocument({ id: DOC_ID, adminAccess: true });
      if (res.metadata) versionRef.current = res.metadata.version;
      if (res.content) {
        const text = await res.content.get('text');
        const data = JSON.parse(text) as IpamData;
        setSubnets(data.subnets ?? []);
        setIpRecords(data.ipRecords ?? []);
      }
      setLastSyncedAt(new Date());
      startPolling();
    } catch (e: unknown) {
      const status = (e as { status?: number })?.status;
      if (status === 403 || status === 401) {
        setPermissionDenied(true);
      } else if (status === 404) {
        setNeedsSetup(true);
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function initializeDatabase(): Promise<'ok' | 'error'> {
    try {
      const emptyData: IpamData = { subnets: [], ipRecords: [] };
      const meta = await documentsClient.createDocument({
        body: { id: DOC_ID, name: 'IPAM Data', type: DOC_TYPE, content: toBlob(emptyData) },
      });
      versionRef.current = meta.version;
      setNeedsSetup(false);
      setLastSyncedAt(new Date());
      startPolling();
      return 'ok';
    } catch {
      return 'error';
    }
  }

  // Sole write path: calls the ipamMutate function and applies whatever it
  // returns. Throws on validation/save failure - callers decide how to show that.
  //
  // Calls functions.call() directly rather than useAppFunction/refetch: that hook
  // closes over `data` from its own creation-time params and its refetch() ignores
  // any argument passed to it, so a fresh per-call payload can never reach it.
  async function mutate(payload: IpamMutation): Promise<IpamMutationResult> {
    isMutatingRef.current = true;
    try {
      const user = getCurrentUserDetails();
      const reportedBy = user.email || user.name || user.id;
      const res = await functions.call('ipamMutate', { data: { mutation: payload, reportedBy } });
      const response = (await res.json()) as IpamMutationResponse;
      if (!response.ok) throw new Error(response.message);
      const result = response.result;
      versionRef.current = result.version;
      setSubnets(result.subnets);
      setIpRecords(result.ipRecords);
      setLastSyncedAt(new Date());
      return result;
    } catch (e: unknown) {
      if (extractErrorStatus(e) === 401 || extractErrorStatus(e) === 403) setPermissionDenied(true);
      await fetchAndApply(true); // resync local state to the server truth after any failed write
      throw new Error(await extractErrorMessage(e));
    } finally {
      isMutatingRef.current = false;
    }
  }

  async function addSubnet(subnet: NewSubnet): Promise<void> {
    await mutate({ type: 'addSubnet', subnet });
  }

  async function updateSubnet(id: string, updates: Partial<NewSubnet>): Promise<void> {
    await mutate({ type: 'updateSubnet', id, updates });
  }

  async function deleteSubnet(id: string): Promise<void> {
    await mutate({ type: 'deleteSubnet', id });
  }

  async function addIpRecord(record: NewIpRecord): Promise<void> {
    await mutate({ type: 'addIpRecord', record });
  }

  async function addIpRecords(records: NewIpRecord[]): Promise<IpamMutationResult> {
    return mutate({ type: 'addIpRecords', records });
  }

  async function updateIpRecord(id: string, updates: Partial<Omit<NewIpRecord, 'subnetId'>>): Promise<void> {
    await mutate({ type: 'updateIpRecord', id, updates });
  }

  async function deleteIpRecord(id: string): Promise<void> {
    await mutate({ type: 'deleteIpRecord', id });
  }

  function getSubnetRecords(subnetId: string): IpRecord[] {
    return ipRecords.filter((r) => r.subnetId === subnetId);
  }

  async function importSubnets(newSubnets: NewSubnet[]): Promise<IpamMutationResult> {
    return mutate({ type: 'importSubnets', subnets: newSubnets });
  }

  async function importIpRecords(
    newSubnets: NewSubnet[],
    newRecords: Array<NewIpRecord & { _tempSubnetCidr: string }>
  ): Promise<IpamMutationResult> {
    return mutate({ type: 'importIpRecords', subnets: newSubnets, records: newRecords });
  }

  return {
    subnets,
    ipRecords,
    isLoading,
    permissionDenied,
    needsSetup,
    lastSyncedAt,
    initializeDatabase,
    addSubnet,
    updateSubnet,
    deleteSubnet,
    addIpRecord,
    addIpRecords,
    updateIpRecord,
    deleteIpRecord,
    getSubnetRecords,
    importSubnets,
    importIpRecords,
  };
}
