import React from 'react';
import { Link } from 'react-router-dom';
import { AppHeader } from '@dynatrace/strato-components-preview/layouts';
import { Text } from '@dynatrace/strato-components/typography';
import { useIpam } from '../context/IpamContext';

function formatSyncTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const Header = () => {
  const { lastSyncedAt } = useIpam();

  return (
    <AppHeader>
      <AppHeader.NavItems>
        <AppHeader.AppNavLink as={Link} to="/" />
        <AppHeader.NavItem as={Link} to="/subnets">Subnets</AppHeader.NavItem>
        <AppHeader.NavItem as={Link} to="/import">Import</AppHeader.NavItem>
      </AppHeader.NavItems>
      {lastSyncedAt && (
        <AppHeader.ActionItems>
          <Text style={{ fontSize: 11, color: 'var(--dt-color-text-subdued)', userSelect: 'none' }}>
            Synced {formatSyncTime(lastSyncedAt)}
          </Text>
        </AppHeader.ActionItems>
      )}
    </AppHeader>
  );
};
