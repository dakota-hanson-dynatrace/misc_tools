import React from 'react';
import { Routes, Route, NavLink, useLocation, useNavigate, type Location } from 'react-router-dom';
import { Flex } from '@dynatrace/strato-components/layouts';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { Hosts } from './pages/Hosts';
import { Kubernetes } from './pages/Kubernetes';
import { Cloud } from './pages/Cloud';
import { HostDetail } from './pages/HostDetail';
import { SlideOverDrawer } from './components/SlideOverDrawer';

const NAV = [
  { to: '/', label: 'Hosts', end: true },
  { to: '/kubernetes', label: 'Kubernetes', end: false },
  { to: '/cloud', label: 'Cloud', end: false },
];

// Hand-rolled nav rather than AppHeader, following the pattern from the NCM
// app (custom_apps/ncm's App.tsx) - plain NavLinks cannot surprise us.
const Nav = () => (
  <Flex gap={4} padding={12} style={{ borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
    {NAV.map((n) => (
      <NavLink
        key={n.to}
        to={n.to}
        end={n.end}
        style={({ isActive }) => ({
          display: 'flex',
          alignItems: 'center',
          padding: '6px 12px',
          borderRadius: 4,
          textDecoration: 'none',
          color: isActive ? Colors.Text.Primary.Default : Colors.Text.Neutral.Default,
          background: isActive ? Colors.Background.Container.Primary.Default : 'transparent',
        })}
      >
        {n.label}
      </NavLink>
    ))}
  </Flex>
);

/**
 * Host detail renders as a right-side drawer over whichever page was
 * showing, using react-router's "background location" pattern (same as the
 * ncm app): the Hosts list navigates to /host/:hostId with
 * `state: { backgroundLocation: location }`, so the URL changes (shareable,
 * back-button-friendly) while the ROUTES underneath keep showing the page the
 * user was actually on.
 *
 * A bookmarked/direct link to /host/:hostId (no backgroundLocation in state)
 * falls through to the first <Routes> block instead, rendering as an
 * ordinary full page - there's nothing to show behind a drawer in that case.
 */
export const App = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const backgroundLocation = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;

  return (
    <Flex flexDirection="column">
      <Nav />
      <Routes location={backgroundLocation ?? location}>
        <Route path="/" element={<Hosts />} />
        <Route path="/kubernetes" element={<Kubernetes />} />
        <Route path="/cloud" element={<Cloud />} />
        <Route path="/host/:hostId" element={<HostDetail />} />
      </Routes>

      {backgroundLocation && (
        <Routes>
          <Route
            path="/host/:hostId"
            element={
              <SlideOverDrawer open onClose={() => navigate(-1)}>
                <HostDetail />
              </SlideOverDrawer>
            }
          />
        </Routes>
      )}
    </Flex>
  );
};
