import assert from 'node:assert/strict';
import { cidrsOverlap, findOverlappingSubnet, isValidIpv4, SubnetOverlapIndex } from './ipUtils';

// No test runner is installed in this project - run with esbuild + node:
//   npx esbuild ui/app/utils/ipUtils.selfcheck.ts --bundle --platform=node --format=cjs --outfile=/tmp/check.js && node /tmp/check.js

assert.equal(cidrsOverlap('10.0.0.0/24', '10.0.0.0/24'), true, 'identical CIDRs must overlap');
assert.equal(cidrsOverlap('10.0.0.0/23', '10.0.0.0/24'), true, 'a supernet must overlap its own subnet');
assert.equal(cidrsOverlap('10.0.0.0/24', '10.0.1.0/24'), false, 'adjacent, non-overlapping /24s must not overlap');
assert.equal(cidrsOverlap('10.0.0.0/24', '10.0.0.128/25'), true, 'a /25 inside an existing /24 must overlap');
assert.equal(cidrsOverlap('192.168.1.0/24', '10.0.0.0/8'), false, 'unrelated ranges must not overlap');

const subnets = [
  { id: 'a', cidr: '10.0.0.0/24' },
  { id: 'b', cidr: '192.168.1.0/24' },
];
assert.equal(findOverlappingSubnet('10.0.0.0/24', subnets)?.id, 'a', 'must find the clashing subnet');
assert.equal(findOverlappingSubnet('10.0.0.0/24', subnets, 'a'), undefined, 'excludeId must let a subnet edit itself');
assert.equal(findOverlappingSubnet('172.16.0.0/24', subnets), undefined, 'no clash expected');

assert.equal(isValidIpv4('192.168.1.10'), true);
assert.equal(isValidIpv4('255.255.255.255'), true);
assert.equal(isValidIpv4('256.0.0.1'), false, 'octet over 255 must be rejected');
assert.equal(isValidIpv4('1.2.3'), false, 'too few octets must be rejected');
assert.equal(isValidIpv4('1.2.3.4.5'), false, 'too many octets must be rejected');

const index = new SubnetOverlapIndex(subnets);
assert.equal(index.findClash('10.0.0.0/24')?.id, 'a', 'index must find the same clash as findOverlappingSubnet');
assert.equal(index.findClash('10.0.0.0/24', 'a'), undefined, 'index must respect excludeId too');
assert.equal(index.findClash('172.16.0.0/24'), undefined, 'index must not false-positive on a disjoint range');
index.add({ id: 'c', cidr: '172.16.0.0/24' });
assert.equal(index.findClash('172.16.0.0/25')?.id, 'c', 'index must see subnets added after construction');

console.log('ipUtils.selfcheck: all assertions passed');
