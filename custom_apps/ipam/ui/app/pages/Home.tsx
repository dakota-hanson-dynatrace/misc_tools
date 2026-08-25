import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Text } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import { SingleValue } from '@dynatrace/strato-components-preview/charts';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { useIpam } from '../context/IpamContext';
import { getSubnetInfo } from '../utils/ipUtils';

function utilizationColor(pct: number): string {
  if (pct >= 95) return 'hsl(0, 75%, 55%)';    // red
  if (pct >= 85) return 'hsl(28, 85%, 55%)';   // orange
  if (pct >= 70) return 'hsl(48, 90%, 50%)';   // yellow
  return 'hsl(150, 55%, 45%)';                  // green
}

export const Home = () => {
  const navigate = useNavigate();
  const { subnets, ipRecords, isLoading } = useIpam();

  const stats = useMemo(() => {
    let totalIps = 0;
    subnets.forEach((s) => {
      try {
        const info = getSubnetInfo(s.cidr);
        totalIps += info.usableHosts;
      } catch {
        // ignore malformed CIDRs
      }
    });
    const assigned = ipRecords.filter((r) => r.status === 'assigned').length;
    const reserved = ipRecords.filter((r) => r.status === 'reserved').length;
    return { totalIps, assigned, reserved };
  }, [subnets, ipRecords]);

  const topSubnets = useMemo(() => {
    const assignedCountBySubnet = new Map<string, number>();
    for (const r of ipRecords) {
      if (r.status !== 'assigned') continue;
      assignedCountBySubnet.set(r.subnetId, (assignedCountBySubnet.get(r.subnetId) ?? 0) + 1);
    }
    return subnets
      .map((s) => {
        let usable = 0;
        try {
          usable = getSubnetInfo(s.cidr).usableHosts;
        } catch {
          // ignore
        }
        const assigned = assignedCountBySubnet.get(s.id) ?? 0;
        const utilization = usable > 0 ? Math.round((assigned / usable) * 100) : 0;
        return { ...s, usable, assigned, utilization };
      })
      .sort((a, b) => b.utilization - a.utilization)
      .slice(0, 5);
  }, [subnets, ipRecords]);

  const available = Math.max(0, stats.totalIps - stats.assigned - stats.reserved);

  return (
    <Flex flexDirection="column" padding={32} gap={32}>
      <Flex justifyContent="space-between" alignItems="center">
        <Heading>IPAM Dashboard</Heading>
        <Flex gap={8}>
          <Button onClick={() => void navigate('/subnets')} variant="accent">
            Manage Subnets
          </Button>
          <Button onClick={() => void navigate('/import')}>Import CSV</Button>
        </Flex>
      </Flex>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {[
          { label: 'Total Subnets', value: subnets.length },
          { label: 'Usable IPs', value: stats.totalIps },
          { label: 'Assigned', value: stats.assigned },
          { label: 'Reserved', value: stats.reserved },
          { label: 'Available', value: available },
        ].map(({ label, value }) => (
          <div
            key={label}
            style={{
              background: Colors.Background.Container.Neutral.Default,
              border: '1px solid var(--dt-color-border-default)',
              borderRadius: 8,
              padding: '12px 16px',
              flex: '1 1 160px',
              height: 116,
            }}
          >
            <SingleValue label={label} data={value} loading={isLoading} />
          </div>
        ))}
      </div>

      {topSubnets.length > 0 && (
        <Flex
          flexDirection="column"
          gap={0}
          padding={20}
          style={{
            background: Colors.Background.Surface.Default,
            border: `1px solid ${Colors.Border.Neutral.Default}`,
            borderRadius: 8,
          }}
        >
          <Heading level={3} style={{ marginBottom: 8 }}>Top Subnets by Utilization</Heading>
          <div style={{ borderTop: `1px solid ${Colors.Border.Neutral.Default}` }} />
          <Flex flexDirection="column">
            {topSubnets.map((s, i) => (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                style={{
                  borderTop: i > 0 ? `1px solid ${Colors.Border.Neutral.Default}` : undefined,
                  cursor: 'pointer',
                }}
                onClick={() => void navigate(`/subnets/${s.id}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void navigate(`/subnets/${s.id}`);
                  }
                }}
              >
                <Flex alignItems="center" padding={16} gap={16}>
                  <Flex flexDirection="column" style={{ minWidth: 200 }}>
                    <Text style={{ fontWeight: 600 }}>{s.name}</Text>
                    <Text style={{ fontSize: 12, color: 'var(--dt-color-text-subdued)' }}>
                      {s.cidr}
                    </Text>
                  </Flex>
                  <Text style={{ flex: 1, fontSize: 12, color: 'var(--dt-color-text-subdued)' }}>
                    {s.assigned} / {s.usable} IPs
                  </Text>
                  <Text style={{ fontSize: 13, fontWeight: 600, minWidth: 48, textAlign: 'right', color: utilizationColor(s.utilization) }}>
                    {s.utilization}%
                  </Text>
                  {s.site && (
                    <Text style={{ fontSize: 12, color: 'var(--dt-color-text-subdued)', minWidth: 80 }}>
                      {s.site}
                    </Text>
                  )}
                </Flex>
                <div style={{ height: 4, margin: '0 16px 8px', borderRadius: 2, background: Colors.Background.Container.Neutral.Default }}>
                  <div style={{
                    height: '100%',
                    width: `${s.utilization}%`,
                    background: utilizationColor(s.utilization),
                    transition: 'width 0.4s ease',
                  }} />
                </div>
              </div>
            ))}
          </Flex>
        </Flex>
      )}

      {!isLoading && subnets.length === 0 && (
        <Flex flexDirection="column" alignItems="center" padding={64} gap={16}>
          <Text>No subnets yet. Add one manually or import from a CSV file.</Text>
          <Flex gap={8}>
            <Button onClick={() => void navigate('/subnets')} variant="accent">
              Add Subnet
            </Button>
            <Button onClick={() => void navigate('/import')}>Import CSV</Button>
          </Flex>
        </Flex>
      )}
    </Flex>
  );
};
