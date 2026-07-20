import { Page } from '@dynatrace/strato-components-preview/layouts';
import React, { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Text } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import { IpamProvider, useIpam } from './context/IpamContext';
import { Header } from './components/Header';
import { Home } from './pages/Home';
import { Subnets } from './pages/Subnets';
import { SubnetDetail } from './pages/SubnetDetail';
import { Import } from './pages/Import';

const SetupScreen = () => {
  const { initializeDatabase } = useIpam();
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');

  async function handleInit() {
    setStatus('loading');
    const result = await initializeDatabase();
    if (result === 'error') setStatus('error');
  }

  return (
    <Flex
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap={16}
      style={{ height: '65vh', maxWidth: 480, margin: '0 auto', textAlign: 'center', padding: '0 16px' }}
    >
      <Text style={{ fontSize: 20, fontWeight: 600 }}>IPAM not initialized</Text>
      <Text style={{ color: 'var(--dt-color-text-subdued)', fontSize: 13, lineHeight: 1.6 }}>
        No IPAM database exists for this tenant yet. Initialize it to create a shared database
        that everyone in the tenant can access automatically.
      </Text>
      {status === 'error' && (
        <Text style={{ color: 'var(--dt-color-text-critical)', fontSize: 13 }}>
          Initialization failed. Make sure the app permissions are approved in Hub → Manage → IPAM.
        </Text>
      )}
      <Button
        onClick={() => void handleInit()}
        variant="accent"
        disabled={status === 'loading'}
      >
        {status === 'loading' ? 'Initializing…' : 'Initialize IPAM for this tenant'}
      </Button>
    </Flex>
  );
};

const PermissionDeniedScreen = () => (
  <Flex
    flexDirection="column"
    alignItems="center"
    justifyContent="center"
    gap={16}
    style={{ height: '60vh', maxWidth: 480, margin: '0 auto', textAlign: 'center', padding: '0 16px' }}
  >
    <Text style={{ fontSize: 20, fontWeight: 600 }}>App permissions required</Text>
    <Text style={{ color: 'var(--dt-color-text-subdued)', fontSize: 13, lineHeight: 1.6 }}>
      The IPAM app needs permission to access the Dynatrace Document Store.
    </Text>
    <Flex
      flexDirection="column"
      gap={8}
      style={{
        textAlign: 'left',
        background: 'var(--dt-color-background-base-default)',
        border: '1px solid var(--dt-color-border-default)',
        borderRadius: 8,
        padding: 20,
        width: '100%',
      }}
    >
      {['Open the Dynatrace Launcher and search for Hub', 'Go to the Manage tab', 'Find the IPAM app and open it', 'Approve the requested permissions', 'Refresh this page'].map(
        (step, i) => (
          <Flex key={i} gap={12} alignItems="flex-start">
            <Text style={{ fontWeight: 700, color: 'var(--dt-color-indicator-primary)', minWidth: 20 }}>{i + 1}.</Text>
            <Text style={{ fontSize: 13 }}>{step}</Text>
          </Flex>
        )
      )}
    </Flex>
  </Flex>
);

const AppRoutes = () => {
  const { isLoading, saveError, permissionDenied, needsSetup } = useIpam();

  if (isLoading) {
    return (
      <Flex alignItems="center" justifyContent="center" style={{ height: '60vh' }}>
        <Text style={{ color: 'var(--dt-color-text-subdued)' }}>Loading IPAM data...</Text>
      </Flex>
    );
  }

  if (permissionDenied) return <PermissionDeniedScreen />;
  if (needsSetup) return <SetupScreen />;

  return (
    <Flex flexDirection="column" style={{ height: '100%' }}>
      {saveError && (
        <Flex
          padding={8}
          justifyContent="center"
          style={{ background: 'var(--dt-color-background-critical-default)', fontSize: 13, flexShrink: 0 }}
        >
          <Text style={{ color: 'var(--dt-color-text-critical)' }}>{saveError}</Text>
        </Flex>
      )}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/subnets" element={<Subnets />} />
        <Route path="/subnets/:id" element={<SubnetDetail />} />
        <Route path="/import" element={<Import />} />
      </Routes>
    </Flex>
  );
};

export const App = () => (
  <IpamProvider>
    <Page>
      <Page.Header>
        <Header />
      </Page.Header>
      <Page.Main>
        <AppRoutes />
      </Page.Main>
    </Page>
  </IpamProvider>
);
