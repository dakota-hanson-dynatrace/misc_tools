export type IpStatus = 'available' | 'assigned' | 'reserved';

export interface Subnet {
  id: string;
  cidr: string;
  name: string;
  description?: string;
  site?: string;
  vlan?: string;
  owner?: string;
  createdAt: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface IpRecord {
  id: string;
  subnetId: string;
  address: string;
  status: IpStatus;
  hostname?: string;
  owner?: string;
  notes?: string;
  updatedAt: string;
  updatedBy?: string;
}

// Shared between the UI and the ipamMutate backend function (api/ipamMutate.function.ts).
// Lives here rather than in api/ because the UI's tsconfig rootDir can't reach outside ui/.

export type NewSubnet = Omit<Subnet, 'id' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy'>;
export type NewIpRecord = Omit<IpRecord, 'id' | 'updatedAt' | 'updatedBy'>;

export type IpamMutation =
  | { type: 'addSubnet'; subnet: NewSubnet }
  | { type: 'updateSubnet'; id: string; updates: Partial<NewSubnet> }
  | { type: 'deleteSubnet'; id: string }
  | { type: 'addIpRecord'; record: NewIpRecord }
  | { type: 'addIpRecords'; records: NewIpRecord[] }
  | { type: 'updateIpRecord'; id: string; updates: Partial<Omit<NewIpRecord, 'subnetId'>> }
  | { type: 'deleteIpRecord'; id: string }
  | { type: 'importSubnets'; subnets: NewSubnet[] }
  | { type: 'importIpRecords'; subnets: NewSubnet[]; records: Array<NewIpRecord & { _tempSubnetCidr: string }> };

// The function's own getCurrentUserDetails() call is the primary identity
// source and should work when the platform populates it for functions; reportedBy
// is the browser's own (unverified) identity, used only as a fallback if it doesn't.
export interface IpamMutationRequest {
  mutation: IpamMutation;
  reportedBy: string;
}

export interface IpamMutationResult {
  subnets: Subnet[];
  ipRecords: IpRecord[];
  version: string;
  added: number;
  skipped: number;
  /** Subnets created as a side effect of importIpRecords (0 for every other mutation type). */
  subnetsAdded: number;
}

// The function always returns this shape and never throws/rejects itself -
// a thrown error from inside the function is reported by the platform as a
// generic "Execution crashed" with no message preserved, so every expected
// (and unexpected) failure is caught internally and reported here instead.
export type IpamMutationResponse =
  | { ok: true; result: IpamMutationResult }
  | { ok: false; message: string };
