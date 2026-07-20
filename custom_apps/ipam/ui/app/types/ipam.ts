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
}
