import React from 'react';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading } from '@dynatrace/strato-components/typography';
import { ExtensionManager } from '../components/ExtensionManager';

export const Manage = () => (
  <Flex flexDirection="column" gap={16} padding={32} style={{ maxWidth: 1100 }}>
    <Heading level={1}>Manage</Heading>
    <ExtensionManager />
  </Flex>
);
