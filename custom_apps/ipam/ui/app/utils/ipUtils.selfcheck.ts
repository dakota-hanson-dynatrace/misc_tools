import assert from 'node:assert/strict';
import { cidrsOverlap, findOverlappingSubnet, isValidIpv4, SubnetOverlapIndex, parseCsvRows } from './ipUtils';

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

const csvRows = parseCsvRows(
  'name,notes\n' +
  '"Corp LAN","Building A, 3rd floor"\n' +
  '"HQ","Line one\nLine two"\n'
);
assert.equal(csvRows.length, 2, 'a quoted embedded newline must not split into an extra row');
assert.equal(csvRows[0].notes, 'Building A, 3rd floor', 'a comma inside quotes must not split the field');
assert.equal(csvRows[1].notes, 'Line one\nLine two', 'a newline inside quotes must stay in one field');

const spacing = parseCsvRows('a,b\n"  x  ",  y  \n');
assert.equal(spacing[0].a, '  x  ', 'whitespace inside a quoted field is significant per RFC 4180 and must be preserved');
assert.equal(spacing[0].b, 'y', 'an unquoted field must still be trimmed');

console.log('ipUtils.selfcheck: all assertions passed');
