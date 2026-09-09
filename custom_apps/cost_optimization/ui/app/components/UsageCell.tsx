import React from 'react';
import { heatColor } from '../lib/colors';

/**
 * Colored % cell for CPU/mem/disk usage.
 *
 * CPU/memory are a cost-optimization view, not a capacity-alert view - a
 * resource paid for and barely used is the wasteful (bad/red) case, and
 * heavy use is the efficient (good/green) one, so their color scale is
 * inverted from the raw usage number (low% -> red, high% -> green). Disk is
 * the opposite: a disk running low is genuinely safe, a disk running full is
 * genuinely at risk, so pass `invert={false}` there to get the traditional
 * direction (low% -> green, high% -> red).
 */
export const UsageCell = ({ value, invert = true }: { value: number; invert?: boolean }) => (
  <span
    style={{
      display: 'inline-block',
      minWidth: 56,
      textAlign: 'right',
      color: heatColor(invert ? 1 - value / 100 : value / 100),
      fontVariantNumeric: 'tabular-nums',
    }}
  >
    {value.toFixed(1)}%
  </span>
);
