import React from 'react';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { STATE_LABEL, type CoverageState } from '../utils/coverage';

// Hand-rolled for the same reason StatusDot is: HealthIndicator rendered the
// same uncoloured glyph for every status in a sibling app.
const COLOR: Record<CoverageState, string> = {
  covered: Colors.Charts.Apdex.Excellent.Default,
  stale: Colors.Charts.Apdex.Fair.Default,
  failing: Colors.Charts.Apdex.Unacceptable.Default,
  never: Colors.Charts.Apdex.Unacceptable.Default,
  ambiguous: Colors.Charts.Apdex.Poor.Default,
  unmonitored: Colors.Text.Neutral.Subdued,
};

// Same fix as StatusDot: centered unconditionally in its own flex wrapper
// rather than relying on DataTable's `align-items: inherit` cell default.
export const CoverageDot = ({ state }: { state: CoverageState }) => (
  <span style={{ display: 'flex', alignItems: 'center', gap: 8, height: '100%' }}>
    <span
      title={STATE_LABEL[state]}
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: '50%',
        flex: '0 0 auto',
        background: COLOR[state],
        // `never` is a hollow ring so it stays distinguishable from `failing`
        // without relying on colour alone.
        boxShadow: state === 'never' ? `inset 0 0 0 2px ${Colors.Background.Field.Neutral.Default}` : undefined,
      }}
    />
    {STATE_LABEL[state]}
  </span>
);
