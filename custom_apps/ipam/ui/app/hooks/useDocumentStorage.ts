import { useEffect, useRef, useState } from 'react';
import { documentsClient } from '@dynatrace-sdk/client-document';
import type { Subnet, IpRecord } from '../types/ipam';

const DOC_ID = 'my-ipam-data-v1';
const DOC_TYPE = 'my-ipam-data';
const POLL_INTERVAL_MS = 20_000;

interface IpamData {
  subnets: Subnet[];
  ipRecords: IpRecord[];
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function toBlob(data: IpamData): Blob {
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

export function useDocumentStorage() {
  const [subnets, setSubnets] = useState<Subnet[]>([]);
  const [ipRecords, setIpRecords] = useState<IpRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  const versionRef = useRef<string>('');
  const existsRef = useRef(false);
  const latestRef = useRef<IpamData>({ subnets: [], ipRecords: [] });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isSavingRef = useRef(false);

  useEffect(() => {
    void load();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function fetchAndApply(forceApply = false): Promise<boolean> {
    try {
      const res = await documentsClient.getDocument({ id: DOC_ID, adminAccess: true });
      const newVersion = res.metadata?.version ?? '';
      if (!forceApply && newVersion && newVersion === versionRef.current) return true;

      if (res.metadata) versionRef.current = res.metadata.version;
      if (res.content) {
        const text = (await res.content.get('text')) as string;
        const data: IpamData = JSON.parse(text);
        const s = data.subnets ?? [];
        const r = data.ipRecords ?? [];
        setSubnets(s);
        setIpRecords(r);
        latestRef.current = { subnets: s, ipRecords: r };
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
      if (!isSavingRef.current && !timerRef.current) void fetchAndApply();
    }, POLL_INTERVAL_MS);
  }

  async function load() {
    try {
      setIsLoading(true);
      setPermissionDenied(false);
      setNeedsSetup(false);

      const res = await documentsClient.getDocument({ id: DOC_ID, adminAccess: true });
      if (res.metadata) {
        versionRef.current = res.metadata.version;
        existsRef.current = true;
      }
      if (res.content) {
        const text = (await res.content.get('text')) as string;
        const data: IpamData = JSON.parse(text);
        const s = data.subnets ?? [];
        const r = data.ipRecords ?? [];
        setSubnets(s);
        setIpRecords(r);
        latestRef.current = { subnets: s, ipRecords: r };
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
      existsRef.current = true;
      setNeedsSetup(false);
      setLastSyncedAt(new Date());
      startPolling();
      return 'ok';
    } catch {
      return 'error';
    }
  }

  function scheduleSave() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void persist();
    }, 800);
  }

  async function persist() {
    if (!existsRef.current) return;
    isSavingRef.current = true;
    setSaveError(null);
    try {
      const meta = await documentsClient.updateDocumentContent({
        id: DOC_ID,
        optimisticLockingVersion: versionRef.current,
        body: { content: toBlob(latestRef.current) },
        adminAccess: true,
      });
      versionRef.current = meta.version;
      setLastSyncedAt(new Date());
    } catch (e: unknown) {
      const status = (e as { status?: number })?.status;
      const msg = (e as { message?: string })?.message ?? String(e);
      console.error('IPAM save failed:', status, msg, e);
      if (status === 409) {
        await fetchAndApply(true);
        setSaveError('Someone else saved a change at the same time. The latest data has been loaded — please redo your edit.');
      } else if (status === 403 || status === 401) {
        setPermissionDenied(true);
      } else {
        setSaveError(`Save failed (${status ?? 'unknown error'}): ${msg}`);
      }
    } finally {
      isSavingRef.current = false;
    }
  }

  function mutateSubnets(updater: (prev: Subnet[]) => Subnet[]) {
    setSubnets((prev) => {
      const next = updater(prev);
      latestRef.current = { ...latestRef.current, subnets: next };
      scheduleSave();
      return next;
    });
  }

  function mutateRecords(updater: (prev: IpRecord[]) => IpRecord[]) {
    setIpRecords((prev) => {
      const next = updater(prev);
      latestRef.current = { ...latestRef.current, ipRecords: next };
      scheduleSave();
      return next;
    });
  }

  function addSubnet(subnet: Omit<Subnet, 'id' | 'createdAt'>): Subnet {
    const next: Subnet = { ...subnet, id: generateId(), createdAt: new Date().toISOString() };
    mutateSubnets((prev) => [...prev, next]);
    return next;
  }

  function updateSubnet(id: string, updates: Partial<Omit<Subnet, 'id' | 'createdAt'>>): void {
    mutateSubnets((prev) => prev.map((s) => (s.id === id ? { ...s, ...updates } : s)));
  }

  function deleteSubnet(id: string): void {
    mutateSubnets((prev) => prev.filter((s) => s.id !== id));
    mutateRecords((prev) => prev.filter((r) => r.subnetId !== id));
  }

  function addIpRecord(record: Omit<IpRecord, 'id' | 'updatedAt'>): IpRecord {
    const next: IpRecord = { ...record, id: generateId(), updatedAt: new Date().toISOString() };
    mutateRecords((prev) => [...prev, next]);
    return next;
  }

  function updateIpRecord(id: string, updates: Partial<Omit<IpRecord, 'id' | 'subnetId'>>): void {
    mutateRecords((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...updates, updatedAt: new Date().toISOString() } : r))
    );
  }

  function deleteIpRecord(id: string): void {
    mutateRecords((prev) => prev.filter((r) => r.id !== id));
  }

  function getSubnetRecords(subnetId: string): IpRecord[] {
    return ipRecords.filter((r) => r.subnetId === subnetId);
  }

  function importSubnets(newSubnets: Omit<Subnet, 'id' | 'createdAt'>[]): void {
    const ts = new Date().toISOString();
    mutateSubnets((prev) => [
      ...prev,
      ...newSubnets.map((s) => ({ ...s, id: generateId(), createdAt: ts })),
    ]);
  }

  function importIpRecords(
    newSubnets: Omit<Subnet, 'id' | 'createdAt'>[],
    newRecords: Array<Omit<IpRecord, 'id' | 'updatedAt'> & { _tempSubnetCidr: string }>
  ): void {
    const ts = new Date().toISOString();
    const cidrToId = new Map<string, string>();
    latestRef.current.subnets.forEach((s) => cidrToId.set(s.cidr, s.id));

    const createdSubnets = newSubnets.map((s) => {
      const id = generateId();
      cidrToId.set(s.cidr, id);
      return { ...s, id, createdAt: ts };
    });

    const resolvedRecords = newRecords
      .map(({ _tempSubnetCidr, subnetId: _ignored, ...r }) => {
        const subnetId = cidrToId.get(_tempSubnetCidr);
        if (!subnetId) return null;
        return { ...r, subnetId, id: generateId(), updatedAt: ts };
      })
      .filter((r): r is IpRecord => r !== null);

    const nextSubnets = [...latestRef.current.subnets, ...createdSubnets];
    const nextRecords = [...latestRef.current.ipRecords, ...resolvedRecords];
    latestRef.current = { subnets: nextSubnets, ipRecords: nextRecords };
    setSubnets(nextSubnets);
    setIpRecords(nextRecords);
    scheduleSave();
  }

  return {
    subnets,
    ipRecords,
    isLoading,
    saveError,
    permissionDenied,
    needsSetup,
    lastSyncedAt,
    initializeDatabase,
    addSubnet,
    updateSubnet,
    deleteSubnet,
    addIpRecord,
    updateIpRecord,
    deleteIpRecord,
    getSubnetRecords,
    importSubnets,
    importIpRecords,
  };
}
