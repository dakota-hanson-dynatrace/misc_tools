import React from 'react';
import { Flex } from '@dynatrace/strato-components/layouts';
import { SingleValue } from '@dynatrace/strato-components-preview/charts';
import Colors from '@dynatrace/strato-design-tokens/colors';

interface Tile {
  label: string;
  value: number | string;
}

// dt-app-ui-design section 4: Container.Neutral.Default is the tile level in
// the surface hierarchy (Base -> Surface -> Container).
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

export const StatTiles = ({ tiles, loading }: { tiles: Tile[]; loading: boolean }) => (
  <Flex gap={12} flexWrap="wrap">
    {tiles.map((tile) => (
      <TileWrap key={tile.label}>
        <SingleValue label={tile.label} data={tile.value} loading={loading} />
      </TileWrap>
    ))}
  </Flex>
);
