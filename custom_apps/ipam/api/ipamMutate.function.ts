import { randomUUID } from 'node:crypto';
import {
  documentsClient,
  isConflict,
  isForbidden,
  isUnauthorized,
  isDocumentOrSnapshotNotFound,
  isExternalIdAlreadyExists,
} from '@dynatrace-sdk/client-document';
import { getCurrentUserDetails } from '@dynatrace-sdk/app-environment';
import { isValidCidr, normalizeNetworkAddress, isValidIpv4, findOverlappingSubnet, SubnetOverlapIndex } from '../ui/app/utils/ipUtils';
import type {
  Subnet,
  IpRecord,
  NewSubnet,
  NewIpRecord,
  IpamMutation,
  IpamMutationRequest,
  IpamMutationResponse,
} from '../ui/app/types/ipam';

// This function is the sole write path this app's own UI uses for IPAM data:
// every subnet/IP-record mutation the frontend performs goes through here,
// centralizing overlap/duplicate validation and createdBy/updatedBy
// attribution in one place instead of leaving it to every page.
//
// That's an application-level guarantee, not an IAM boundary: the function
// runs under the same document scopes the browser bundle already holds (see
// load()/initializeDatabase() in useDocumentStorage.ts), so it doesn't stop a
// caller who already has that scope from writing to the document directly.
//
// The IpamMutation/IpamMutationResult contract lives in ui/app/types/ipam.ts,
// not here, because the UI's tsconfig rootDir can't import anything outside ui/.

const DOC_ID = 'my-ipam-data-v1';
const DOC_TYPE = 'my-ipam-data';

interface IpamData {
  subnets: Subnet[];
  ipRecords: IpRecord[];
}

class ValidationError extends Error {}

// `index`/`dupeKeys` are optional precomputed caches bulk callers pass in so
// importing/syncing many records doesn't re-scan (and re-derive CIDR bounds
// for) the whole existing data set on every single item - see importSubnets/
// importIpRecords/addIpRecords below. The single-item callers omit them and
// fall back to scanning `data` directly, which is fine for one item.

function addOneSubnet(data: IpamData, subnet: NewSubnet, actor: string, index?: SubnetOverlapIndex<Subnet>): Subnet {
  if (!subnet.name?.trim()) throw new ValidationError('Subnet name is required.');
  if (!isValidCidr(subnet.cidr)) throw new ValidationError(`Invalid CIDR: ${subnet.cidr}`);
  const cidr = normalizeNetworkAddress(subnet.cidr);
  const clash = index ? index.findClash(cidr) : findOverlappingSubnet(cidr, data.subnets);
  if (clash) throw new ValidationError(`${cidr} overlaps with existing subnet "${clash.name}" (${clash.cidr}).`);
  const created: Subnet = { ...subnet, cidr, id: randomUUID(), createdAt: new Date().toISOString(), createdBy: actor };
  data.subnets.push(created);
  index?.add(created);
  return created;
}

function addOneIpRecord(data: IpamData, record: NewIpRecord, actor: string, dupeKeys?: Set<string>): IpRecord {
  if (!isValidIpv4(record.address)) throw new ValidationError(`Invalid IPv4 address: ${record.address}`);
  const key = `${record.subnetId}|${record.address}`;
  const isDupe = dupeKeys
    ? dupeKeys.has(key)
    : data.ipRecords.some((r) => r.subnetId === record.subnetId && r.address === record.address);
  if (isDupe) throw new ValidationError(`${record.address} is already tracked in this subnet.`);
  const created: IpRecord = { ...record, id: randomUUID(), updatedAt: new Date().toISOString(), updatedBy: actor };
  data.ipRecords.push(created);
  dupeKeys?.add(key);
  return created;
}

type MutationTally = { added: number; skipped: number; subnetsAdded: number };

function applyMutation(data: IpamData, mutation: IpamMutation, actor: string): MutationTally {
  switch (mutation.type) {
    case 'addSubnet': {
      addOneSubnet(data, mutation.subnet, actor);
      return { added: 1, skipped: 0, subnetsAdded: 0 };
    }
    case 'updateSubnet': {
      const subnet = data.subnets.find((s) => s.id === mutation.id);
      if (!subnet) throw new ValidationError('Subnet not found.');
      const updates = { ...mutation.updates };
      if (updates.name !== undefined && !updates.name.trim()) {
        throw new ValidationError('Subnet name is required.');
      }
      if (updates.cidr !== undefined) {
        if (!isValidCidr(updates.cidr)) throw new ValidationError(`Invalid CIDR: ${updates.cidr}`);
        updates.cidr = normalizeNetworkAddress(updates.cidr);
        const clash = findOverlappingSubnet(updates.cidr, data.subnets, subnet.id);
        if (clash) throw new ValidationError(`Overlaps with existing subnet "${clash.name}" (${clash.cidr}).`);
      }
      // createdAt/createdBy are re-pinned after the merge (not just omitted from
      // the NewSubnet type) so a raw payload can't overwrite the original creator.
      Object.assign(subnet, updates, {
        createdAt: subnet.createdAt,
        createdBy: subnet.createdBy,
        updatedAt: new Date().toISOString(),
        updatedBy: actor,
      });
      return { added: 0, skipped: 0, subnetsAdded: 0 };
    }
    case 'deleteSubnet': {
      data.subnets = data.subnets.filter((s) => s.id !== mutation.id);
      data.ipRecords = data.ipRecords.filter((r) => r.subnetId !== mutation.id);
      return { added: 0, skipped: 0, subnetsAdded: 0 };
    }
    case 'addIpRecord': {
      addOneIpRecord(data, mutation.record, actor);
      return { added: 1, skipped: 0, subnetsAdded: 0 };
    }
    case 'addIpRecords': {
      let added = 0;
      let skipped = 0;
      const dupeKeys = new Set(data.ipRecords.map((r) => `${r.subnetId}|${r.address}`));
      for (const r of mutation.records) {
        try {
          addOneIpRecord(data, r, actor, dupeKeys);
          added++;
        } catch (e) {
          if (!(e instanceof ValidationError)) throw e;
          skipped++;
        }
      }
      return { added, skipped, subnetsAdded: 0 };
    }
    case 'updateIpRecord': {
      const record = data.ipRecords.find((r) => r.id === mutation.id);
      if (!record) throw new ValidationError('IP record not found.');
      const updates = { ...mutation.updates };
      if (updates.address !== undefined && updates.address !== record.address) {
        if (!isValidIpv4(updates.address)) throw new ValidationError(`Invalid IPv4 address: ${updates.address}`);
        const dupe = data.ipRecords.find(
          (r) => r.id !== record.id && r.subnetId === record.subnetId && r.address === updates.address
        );
        if (dupe) throw new ValidationError(`${updates.address} is already tracked in this subnet.`);
      }
      Object.assign(record, updates, { updatedAt: new Date().toISOString(), updatedBy: actor });
      return { added: 0, skipped: 0, subnetsAdded: 0 };
    }
    case 'deleteIpRecord': {
      data.ipRecords = data.ipRecords.filter((r) => r.id !== mutation.id);
      return { added: 0, skipped: 0, subnetsAdded: 0 };
    }
    case 'importSubnets': {
      let added = 0;
      let skipped = 0;
      const index = new SubnetOverlapIndex(data.subnets);
      for (const s of mutation.subnets) {
        try {
          addOneSubnet(data, s, actor, index);
          added++;
        } catch (e) {
          if (!(e instanceof ValidationError)) throw e;
          skipped++;
        }
      }
      return { added, skipped, subnetsAdded: 0 };
    }
    case 'importIpRecords': {
      const cidrToId = new Map(data.subnets.map((s) => [s.cidr, s.id]));
      const subnetIndex = new SubnetOverlapIndex(data.subnets);
      let subnetsAdded = 0;
      for (const s of mutation.subnets) {
        try {
          const created = addOneSubnet(data, s, actor, subnetIndex);
          cidrToId.set(created.cidr, created.id);
          subnetsAdded++;
        } catch (e) {
          if (!(e instanceof ValidationError)) throw e;
          // Subnet already exists or overlaps - records below are skipped if
          // they can't resolve to a known subnet id.
        }
      }
      let added = 0;
      let skipped = 0;
      const dupeKeys = new Set(data.ipRecords.map((r) => `${r.subnetId}|${r.address}`));
      for (const { _tempSubnetCidr, ...r } of mutation.records) {
        const subnetId = cidrToId.get(_tempSubnetCidr);
        if (!subnetId) {
          skipped++;
          continue;
        }
        try {
          addOneIpRecord(data, { ...r, subnetId }, actor, dupeKeys);
          added++;
        } catch (e) {
          if (!(e instanceof ValidationError)) throw e;
          skipped++;
        }
      }
      return { added, skipped, subnetsAdded };
    }
    default: {
      const unknownType = (mutation as { type?: unknown })?.type;
      throw new ValidationError(`Unknown mutation type: ${String(unknownType)}`);
    }
  }
}

const MISSING_USER_SENTINEL = 'dt.missing.user.id';

// The Dynatrace runtime reports any exception thrown out of this function as a
// generic "Execution crashed" with no message preserved - so nothing below is
// allowed to throw out of this function. Every failure, expected (ValidationError)
// or not, is caught and reported through the ok:false response instead.
export default async function (request: IpamMutationRequest): Promise<IpamMutationResponse> {
  try {
    const user = getCurrentUserDetails();
    const actor = user.id !== MISSING_USER_SENTINEL
      ? (user.email || user.name || user.id || 'unknown')
      : String(request.reportedBy ?? '').slice(0, 200) || 'unknown';
    const payload = request.mutation;

    for (let attempt = 0; ; attempt++) {
      let version: string;
      let data: IpamData;
      try {
        const res = await documentsClient.getDocument({ id: DOC_ID, adminAccess: true });
        version = res.metadata?.version ?? '';
        const text = res.content ? await res.content.get('text') : '{"subnets":[],"ipRecords":[]}';
        data = JSON.parse(text) as IpamData;
      } catch (e) {
        // Self-heals a document that was never created (or hasn't propagated
        // yet after initializeDatabase() created it from a different, browser-
        // side execution context) instead of assuming the document always exists.
        if (!isDocumentOrSnapshotNotFound(e)) throw e;
        try {
          const emptyData: IpamData = { subnets: [], ipRecords: [] };
          const meta = await documentsClient.createDocument({
            body: {
              id: DOC_ID,
              name: 'IPAM Data',
              type: DOC_TYPE,
              content: new Blob([JSON.stringify(emptyData)], { type: 'application/json' }),
            },
          });
          version = meta.version;
          data = emptyData;
        } catch (createError) {
          if (isExternalIdAlreadyExists(createError) && attempt < 2) continue; // someone else created it first, reload
          throw createError;
        }
      }
      data.subnets ??= [];
      data.ipRecords ??= [];

      const { added, skipped, subnetsAdded } = applyMutation(data, payload, actor);

      try {
        const meta = await documentsClient.updateDocumentContent({
          id: DOC_ID,
          optimisticLockingVersion: version,
          body: { content: new Blob([JSON.stringify(data)], { type: 'application/json' }) },
          adminAccess: true,
        });
        return {
          ok: true,
          result: { subnets: data.subnets, ipRecords: data.ipRecords, version: meta.version, added, skipped, subnetsAdded },
        };
      } catch (e) {
        if (isConflict(e) && attempt < 2) continue; // someone else saved first, reload and retry
        throw e;
      }
    }
  } catch (e) {
    console.error('ipamMutate failed:', e);
    return { ok: false, message: e instanceof Error ? e.message : String(e), permissionDenied: isForbidden(e) || isUnauthorized(e) };
  }
}
