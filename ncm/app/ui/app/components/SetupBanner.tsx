import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Text } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { useSetupStatus } from '../hooks/useSetupStatus';

/**
 * Persistent, not dismissible: this is a live reflection of real state (do
 * the dedicated buckets/pipeline/routing exist), not a one-time "welcome"
 * notice with its own dismissal flag to track. It disappears on its own the
 * moment Initial Setup actually reports all-green, and reappears if that
 * ever regresses - there is nothing here for a user to silence.
 */
export const SetupBanner = () => {
  const { complete } = useSetupStatus();
  const navigate = useNavigate();

  if (complete !== false) return null;

  return (
    <Flex
      justifyContent="space-between"
      alignItems="center"
      gap={12}
      style={{
        padding: '10px 16px',
        background: Colors.Background.Container.Critical.Accent,
        borderBottom: `1px solid ${Colors.Border.Neutral.Default}`,
      }}
    >
      <Text>
        Initial Setup isn't complete - captured configs may be landing in <code>default_logs</code> instead of the
        dedicated buckets.
      </Text>
      <Button onClick={() => navigate('/setup')}>Go to Initial Setup</Button>
    </Flex>
  );
};
