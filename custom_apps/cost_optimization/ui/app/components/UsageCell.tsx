import React from 'react';
import { heatColor } from '../lib/colors';

/** Colored % cell for CPU/mem/disk usage - background tint scales with value/100. */
export const UsageCell = ({ value }: { value: number }) => (
  <span
    style={{
      display: 'inline-block',
      minWidth: 56,
      padding: '2px 8px',
      borderRadius: 4,
      textAlign: 'right',
      background: heatColor(value / 100),
      color: '#fff',
      fontVariantNumeric: 'tabular-nums',
    }}
  >
    {value.toFixed(1)}%
  </span>
);
