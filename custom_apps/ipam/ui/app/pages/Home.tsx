import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph, Text } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import { useIpam } from '../context/IpamContext';
import { getSubnetInfo } from '../utils/ipUtils';

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
}

const StatCard = ({ label, value, sub }: StatCardProps) => (
  <Flex
    flexDirection="column"
    padding={24}
    style={{
      background: 'var(--dt-color-background-base-default)',
      border: '1px solid var(--dt-color-border-default)',
      borderRadius: 8,
      minWidth: 160,
    }}
  >
    <Text style={{ fontSize: 13, color: 'var(--dt-color-text-subdued)' }}>{label}</Text>
    <Heading level={2} style={{ margin: '4px 0 0' }}>
      {value}
    </Heading>
    {sub && (
      <Text style={{ fontSize: 12, color: 'var(--dt-color-text-subdued)', marginTop: 2 }}>
        {sub}
      </Text>
    )}
  </Flex>
);

export const Home = () => {
  const navigate = useNavigate();
  const { subnets, ipRecords } = useIpam();

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
    return subnets
      .map((s) => {
        let usable = 0;
        try {
          usable = getSubnetInfo(s.cidr).usableHosts;
        } catch {
          // ignore
        }
        const subnetRecords = ipRecords.filter((r) => r.subnetId === s.id);
        const assigned = subnetRecords.filter((r) => r.status === 'assigned').length;
        const utilization = usable > 0 ? Math.round((assigned / usable) * 100) : 0;
        return { ...s, usable, assigned, utilization };
      })
      .sort((a, b) => b.utilization - a.utilization)
      .slice(0, 5);
  }, [subnets, ipRecords]);

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

      <Flex gap={16} flexFlow="wrap">
        <StatCard label="Total Subnets" value={subnets.length} />
        <StatCard label="Usable IPs" value={stats.totalIps.toLocaleString()} />
        <StatCard label="Assigned" value={stats.assigned} />
        <StatCard label="Reserved" value={stats.reserved} />
        <StatCard
          label="Available"
          value={Math.max(0, stats.totalIps - stats.assigned - stats.reserved).toLocaleString()}
        />
      </Flex>

      {topSubnets.length > 0 && (
        <Flex flexDirection="column" gap={12}>
          <Heading level={3}>Top Subnets by Utilization</Heading>
          <Flex flexDirection="column" gap={8}>
            {topSubnets.map((s) => (
              <Flex
                key={s.id}
                alignItems="center"
                padding={16}
                gap={16}
                style={{
                  background: 'var(--dt-color-background-base-default)',
                  border: '1px solid var(--dt-color-border-default)',
                  borderRadius: 6,
                  cursor: 'pointer',
                }}
                onClick={() => void navigate(`/subnets/${s.id}`)}
              >
                <Flex flexDirection="column" style={{ minWidth: 200 }}>
                  <Text style={{ fontWeight: 600 }}>{s.name}</Text>
                  <Text style={{ fontSize: 12, color: 'var(--dt-color-text-subdued)' }}>
                    {s.cidr}
                  </Text>
                </Flex>
                <Flex flexDirection="column" style={{ flex: 1 }}>
                  <Flex justifyContent="space-between" style={{ marginBottom: 4 }}>
                    <Text style={{ fontSize: 12 }}>
                      {s.assigned} / {s.usable} IPs
                    </Text>
                    <Text style={{ fontSize: 12, fontWeight: 600 }}>{s.utilization}%</Text>
                  </Flex>
                  <div
                    style={{
                      height: 6,
                      background: 'var(--dt-color-border-default)',
                      borderRadius: 3,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${s.utilization}%`,
                        background:
                          s.utilization > 90
                            ? 'var(--dt-color-indicator-critical)'
                            : s.utilization > 70
                              ? 'var(--dt-color-indicator-warning)'
                              : 'var(--dt-color-indicator-success)',
                        borderRadius: 3,
                        transition: 'width 0.3s ease',
                      }}
                    />
                  </div>
                </Flex>
                {s.site && (
                  <Text style={{ fontSize: 12, color: 'var(--dt-color-text-subdued)', minWidth: 80 }}>
                    {s.site}
                  </Text>
                )}
              </Flex>
            ))}
          </Flex>
        </Flex>
      )}

      {subnets.length === 0 && (
        <Flex flexDirection="column" alignItems="center" padding={64} gap={16}>
          <Paragraph>No subnets yet. Add one manually or import from a CSV file.</Paragraph>
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
