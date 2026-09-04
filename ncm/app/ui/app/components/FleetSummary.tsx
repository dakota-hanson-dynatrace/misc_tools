import React from 'react';
import { Flex } from '@dynatrace/strato-components/layouts';
import { SingleValue } from '@dynatrace/strato-components-preview/charts';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { fleetSummary } from '../queries';
import { useNcmQuery, num } from '../hooks/useNcm';
import { QueryError } from './QueryError';

interface Row {
  devices: string; sites: string; versions: string; captures: string; failing: string;
}

// Skill: dt-app-ui-design section 4. Container.Neutral.Default is the tile
// level in the surface hierarchy (Base -> Surface -> Container) - a stat tile
// is a Container, not a Surface, so this replaces the earlier <Surface>-based
// tile that sat one level too high in that hierarchy.
const TileWrap = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      background: Colors.Background.Container.Neutral.Default,
      border: `1px solid ${Colors.Border.Neutral.Default}`,
      borderRadius: 8,
      padding: '12px 16px',
      flex: '1 1 200px',
      height: 116,
    }}
  >
    {children}
  </div>
);

export const FleetSummary = () => {
  const { rows, error, isLoading } = useNcmQuery<Row>(fleetSummary());
  if (error) return <QueryError what="fleet summary" error={error} />;
  const r = rows[0];

  // Always render the same five tiles, loading or not - a point-in-time count
  // has no sparkline (skill: omit Sparkline entirely for counts/statuses), and
  // "always pass loading" is what avoids the row popping in and shifting layout.
  const tiles: [string, number][] = [
    ['Devices', num(r?.devices)],
    ['Sites', num(r?.sites)],
    ['Config versions', num(r?.versions)],
    ['Captures', num(r?.captures)],
    ['Failing devices', num(r?.failing)],
  ];

  return (
    <Flex gap={12} flexWrap="wrap">
      {tiles.map(([label, value]) => (
        <TileWrap key={label}>
          <SingleValue label={label} data={value} loading={isLoading} />
        </TileWrap>
      ))}
    </Flex>
  );
};
