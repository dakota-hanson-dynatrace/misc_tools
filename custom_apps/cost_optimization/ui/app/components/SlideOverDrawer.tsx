import React from 'react';
import Colors from '@dynatrace/strato-design-tokens/colors';

/**
 * A right-side overlay panel - dt-app-ui-design section 3's absolutely-
 * positioned overlay pattern (fixed here, since it covers the whole viewport).
 * Pattern lifted from the ncm app's SlideOverDrawer.
 *
 * No close button of its own - the wrapped content owns a back/close control
 * wired to `navigate(-1)`; the backdrop click still needs its own `onClose`.
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
