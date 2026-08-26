import React from 'react';
import Colors from '@dynatrace/strato-design-tokens/colors';

/**
 * A right-side overlay panel - dt-app-ui-design section 3's absolutely-
 * positioned overlay pattern, using `position: fixed` rather than `absolute`
 * since this covers the whole viewport, not a small in-page popover.
 *
 * Deliberately has no close button of its own. The wrapped content (Device
 * detail / Diff) already has its own back/close control, wired to
 * `navigate(-1)` by the caller - that stays the single source of truth for
 * closing, rather than adding a second, redundant close affordance here.
 * The backdrop click still needs its own `onClose`, since nothing inside the
 * content owns that gesture.
 *
 * `Background.Base.Default` (the page-canvas token), not `Surface.Default`,
 * because the drawer's content is a full page's worth of markup that already
 * uses `Surface` for its OWN internal sub-panels - using `Surface` here too
 * would double up a level of the Base -> Surface -> Container hierarchy.
 */
export const SlideOverDrawer = ({
  open,
  onClose,
  children,
  width = 'min(1000px, 92vw)',
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  width?: string | number;
}) => (
  <>
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.45)',
        zIndex: 20,
        opacity: open ? 1 : 0,
        pointerEvents: open ? 'auto' : 'none',
        transition: 'opacity 200ms ease',
      }}
    />
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width,
        background: Colors.Background.Base.Default,
        borderLeft: `1px solid ${Colors.Border.Neutral.Default}`,
        zIndex: 21,
        overflowY: 'auto',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 220ms ease',
        boxShadow: '-8px 0 24px rgba(0, 0, 0, 0.35)',
      }}
    >
      {children}
    </div>
  </>
);
