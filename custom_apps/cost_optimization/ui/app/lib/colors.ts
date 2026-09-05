// Data-channel colors (dt-app-ui-design skill section 2) - named constants,
// never structural design tokens, so each resource dimension keeps a stable
// identity across tabs.
export const CPU_COLOR = 'rgb(90, 140, 210)'; // blue
export const MEM_COLOR = 'hsl(150, 55%, 45%)'; // emerald
export const DISK_COLOR = 'rgb(120, 145, 180)'; // slate-blue
export const WARN_COLOR = 'hsl(28, 85%, 55%)'; // amber

/** 0 = healthy (green), 0.5 = warning (yellow), 1 = critical (red). */
export function heatColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const hue = 120 - clamped * 120; // 120 green -> 60 yellow -> 0 red
  return `hsl(${hue}, 70%, 40%)`;
}
