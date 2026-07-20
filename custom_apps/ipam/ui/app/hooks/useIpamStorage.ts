import { useState, useEffect } from 'react';
import type { Subnet, IpRecord } from '../types/ipam';

const SUBNETS_KEY = 'ipam_subnets';
const IP_RECORDS_KEY = 'ipam_ip_records';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function load<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function save<T>(key: string, data: T[]): void {
  localStorage.setItem(key, JSON.stringify(data));
}

export function useIpamStorage() {
  const [subnets, setSubnets] = useState<Subnet[]>(() => load<Subnet>(SUBNETS_KEY));
  const [ipRecords, setIpRecords] = useState<IpRecord[]>(() => load<IpRecord>(IP_RECORDS_KEY));

  useEffect(() => { save(SUBNETS_KEY, subnets); }, [subnets]);
  useEffect(() => { save(IP_RECORDS_KEY, ipRecords); }, [ipRecords]);

  function addSubnet(subnet: Omit<Subnet, 'id' | 'createdAt'>): Subnet {
    const next: Subnet = { ...subnet, id: generateId(), createdAt: new Date().toISOString() };
    setSubnets((prev) => [...prev, next]);
    return next;
  }

  function updateSubnet(id: string, updates: Partial<Omit<Subnet, 'id' | 'createdAt'>>): void {
    setSubnets((prev) => prev.map((s) => (s.id === id ? { ...s, ...updates } : s)));
  }

  function deleteSubnet(id: string): void {
    setSubnets((prev) => prev.filter((s) => s.id !== id));
    setIpRecords((prev) => prev.filter((r) => r.subnetId !== id));
  }

  function addIpRecord(record: Omit<IpRecord, 'id' | 'updatedAt'>): IpRecord {
    const next: IpRecord = { ...record, id: generateId(), updatedAt: new Date().toISOString() };
    setIpRecords((prev) => [...prev, next]);
    return next;
  }

  function updateIpRecord(id: string, updates: Partial<Omit<IpRecord, 'id' | 'subnetId'>>): void {
    setIpRecords((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...updates, updatedAt: new Date().toISOString() } : r))
    );
  }

  function deleteIpRecord(id: string): void {
    setIpRecords((prev) => prev.filter((r) => r.id !== id));
  }

  function getSubnetRecords(subnetId: string): IpRecord[] {
    return ipRecords.filter((r) => r.subnetId === subnetId);
  }

  function importSubnets(newSubnets: Omit<Subnet, 'id' | 'createdAt'>[]): void {
    const ts = new Date().toISOString();
    setSubnets((prev) => [
      ...prev,
      ...newSubnets.map((s) => ({ ...s, id: generateId(), createdAt: ts })),
    ]);
  }

  return {
    subnets,
    ipRecords,
    addSubnet,
    updateSubnet,
    deleteSubnet,
    addIpRecord,
    updateIpRecord,
    deleteIpRecord,
    getSubnetRecords,
    importSubnets,
  };
}
