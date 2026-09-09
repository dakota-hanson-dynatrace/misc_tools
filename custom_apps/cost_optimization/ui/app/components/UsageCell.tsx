import React from 'react';
import { heatColor } from '../lib/colors';

/**
 * Colored % cell for CPU/mem/disk usage. This is a cost-optimization view,
 * not a capacity-alert view - a resource paid for and barely used is the
 * wasteful (bad/red) case, and heavy use is the efficient (good/green) one,
 * so the color scale is inverted from the raw usage number: low% -> red,
 * high% -> green.
 */
export const UsageCell = ({ value }: { value: number }) => (
  <span
    style={{
      display: 'inline-block',
      minWidth: 56,
      textAlign: 'right',
      color: heatColor(1 - value / 100),
      fontVariantNumeric: 'tabular-nums',
    }}
  >
    {value.toFixed(1)}%
  </span>
);
