// Data-channel colors (dt-app-ui-design skill section 2) - named constants,
// never structural design tokens, so each resource dimension keeps a stable
// identity across tabs.
export const CPU_COLOR = 'rgb(90, 140, 210)'; // blue
export const MEM_COLOR = 'hsl(150, 55%, 45%)'; // emerald
export const DISK_COLOR = 'rgb(120, 145, 180)'; // slate-blue
export const WARN_COLOR = 'hsl(28, 85%, 55%)'; // amber

/** 0 = cool/low usage (slate-blue), 1 = hot/high usage (amber). */
export function heatColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const r = Math.round(120 + clamped * 115);
  const g = Math.round(145 + clamped * 5);
  const b = Math.round(180 - clamped * 135);
  return `rgb(${r}, ${g}, ${b})`;
}
