import React from 'react';
import Colors from '@dynatrace/strato-design-tokens/colors';

// Hand-rolled rather than HealthIndicator: in a sibling app that component
// type-checked, deployed, and rendered the same uncoloured glyph for every
// status. Not repeating that without a way to see the result first.
//
// DataTable's default cell wrapper is `display: flex; align-items: inherit`
// (confirmed by reading DataTableDefaultCell.css) - `inherit` means it takes
// whatever an ancestor sets, which may not be `center`. An inline-block dot
// with no vertical-align of its own then sits at the text baseline rather than
// centered in the row, which is what the first real screenshot showed. Fixing
// it here, in a flex wrapper that centers unconditionally, means the dot is
// correctly centered regardless of what DataTable's ancestor chain resolves
// `inherit` to - it does not depend on that being right.
//
// justifyContent centers horizontally too: the column is wider than the 10px
// dot (see Devices.tsx's `health` column width, sized to fit the "Status"
// header + sort affordance, not the dot), so without this the dot sits flush
// left in its own track instead of centered in it.
export const StatusDot = ({ ok }: { ok: boolean }) => (
  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}>

    <span
      title={ok ? 'All captures succeeded' : 'Has failed captures'}
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: '50%',
        flex: '0 0 auto',
        background: ok ? Colors.Charts.Apdex.Excellent.Default : Colors.Charts.Apdex.Unacceptable.Default,
      }}
    />
  </span>
);
