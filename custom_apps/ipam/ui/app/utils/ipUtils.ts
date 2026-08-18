export function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function intToIp(n: number): string {
  return [
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255,
  ].join('.');
}

export function isValidCidr(cidr: string): boolean {
  const match = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!match) return false;
  const parts = [match[1], match[2], match[3], match[4]].map(Number);
  const prefix = Number(match[5]);
  return parts.every((p) => p >= 0 && p <= 255) && prefix >= 0 && prefix <= 32;
}

export interface SubnetInfo {
  networkAddress: string;
  broadcastAddress: string;
  firstUsable: string;
  lastUsable: string;
  totalHosts: number;
  usableHosts: number;
  prefix: number;
}

export function getSubnetInfo(cidr: string): SubnetInfo {
  const [ipStr, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const ipInt = ipToInt(ipStr);
  const networkInt = (ipInt & mask) >>> 0;
  const broadcastInt = (networkInt | (~mask >>> 0)) >>> 0;
  const totalHosts = Math.pow(2, 32 - prefix);
  const usableHosts = prefix >= 31 ? totalHosts : Math.max(0, totalHosts - 2);

  return {
    networkAddress: intToIp(networkInt),
    broadcastAddress: intToIp(broadcastInt),
    firstUsable: prefix >= 31 ? intToIp(networkInt) : intToIp(networkInt + 1),
    lastUsable: prefix >= 31 ? intToIp(broadcastInt) : intToIp(broadcastInt - 1),
    totalHosts,
    usableHosts,
    prefix,
  };
}

export function normalizeNetworkAddress(cidr: string): string {
  const [ipStr, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const networkInt = (ipToInt(ipStr) & mask) >>> 0;
  return `${intToIp(networkInt)}/${prefix}`;
}

export function isValidIpv4(ip: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').map(Number).every((p) => p >= 0 && p <= 255);
}

export interface CidrBounds {
  networkInt: number;
  broadcastInt: number;
}

export function cidrBounds(cidr: string): CidrBounds {
  const info = getSubnetInfo(cidr);
  return { networkInt: ipToInt(info.networkAddress), broadcastInt: ipToInt(info.broadcastAddress) };
}

function boundsOverlap(a: CidrBounds, b: CidrBounds): boolean {
  return a.networkInt <= b.broadcastInt && b.networkInt <= a.broadcastInt;
}

export function cidrsOverlap(cidrA: string, cidrB: string): boolean {
  return boundsOverlap(cidrBounds(cidrA), cidrBounds(cidrB));
}

export function findOverlappingSubnet<T extends { id: string; cidr: string }>(
  cidr: string,
  subnets: T[],
  excludeId?: string
): T | undefined {
  return subnets.find((s) => s.id !== excludeId && cidrsOverlap(cidr, s.cidr));
}

// Precomputes each subnet's bounds once so a bulk import/sync can check many
// new CIDRs against a large existing set without recomputing getSubnetInfo
// (string parsing + bit math) for the same unchanged subnets on every check.
export class SubnetOverlapIndex<T extends { id: string; cidr: string }> {
  private entries: Array<{ subnet: T; bounds: CidrBounds }>;

  constructor(subnets: T[]) {
    this.entries = subnets.map((subnet) => ({ subnet, bounds: cidrBounds(subnet.cidr) }));
  }

  findClash(cidr: string, excludeId?: string): T | undefined {
    const bounds = cidrBounds(cidr);
    return this.entries.find((e) => e.subnet.id !== excludeId && boundsOverlap(bounds, e.bounds))?.subnet;
  }

  add(subnet: T): void {
    this.entries.push({ subnet, bounds: cidrBounds(subnet.cidr) });
  }
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  try {
    const [, prefixStr] = cidr.split('/');
    const prefix = parseInt(prefixStr, 10);
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const networkInt = (ipToInt(ip.split('/')[0]) & mask) >>> 0;
    const cidrNetworkInt = (ipToInt(cidr.split('/')[0]) & mask) >>> 0;
    return networkInt === cidrNetworkInt;
  } catch {
    return false;
  }
}

function parseRfc4180Row(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { values.push(current.trim()); current = ''; }
      else { current += ch; }
    }
  }
  values.push(current.trim());
  return values;
}

export function parseCsvRows(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = parseRfc4180Row(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseRfc4180Row(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
    return row;
  });
}
