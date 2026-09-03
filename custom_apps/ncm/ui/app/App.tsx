import React from 'react';
import { Routes, Route, NavLink, useLocation, useNavigate, type Location } from 'react-router-dom';
import { Flex } from '@dynatrace/strato-components/layouts';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { Devices } from './pages/Devices';
import { Coverage } from './pages/Coverage';
import { Changes } from './pages/Changes';
import { Failures } from './pages/Failures';
import { Setup } from './pages/Setup';
import { Manage } from './pages/Manage';
import { Credentials } from './pages/Credentials';
import { DeviceDetail } from './pages/DeviceDetail';
import { Diff } from './pages/Diff';
import { SlideOverDrawer } from './components/SlideOverDrawer';
import { SetupBanner } from './components/SetupBanner';
import { useSetupStatus } from './hooks/useSetupStatus';

const NAV = [
  { to: '/', label: 'Devices', end: true },
  { to: '/coverage', label: 'Coverage', end: false },
  { to: '/changes', label: 'Changes', end: false },
  { to: '/failures', label: 'Backup failures', end: false },
  { to: '/setup', label: 'Initial Setup', end: false },
  { to: '/manage', label: 'Manage', end: false },
  { to: '/credentials', label: 'Bulk Credentials', end: false },
];

// Hand-rolled nav rather than AppHeader: verified-by-eye is the rule in this
// codebase after Sheet and HealthIndicator both type-checked, deployed, and
// rendered wrong in a sibling app. Plain links cannot surprise us.
const Nav = () => {
  // Same live status as SetupBanner, queried independently rather than
  // lifted into a shared context - one more cheap dry-run status call is not
  // worth the wiring to avoid, and it keeps this component self-contained.
  const { complete } = useSetupStatus();
  return (
    <Flex gap={4} padding={12} style={{ borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          style={({ isActive }) => ({
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            borderRadius: 4,
            textDecoration: 'none',
            color: isActive ? Colors.Text.Primary.Default : Colors.Text.Neutral.Default,
            // dt-app-ui-design section 2: Container.Primary.Default is the
            // documented token for "selected row / active state" - the earlier
            // Field.Neutral.Accent was an invented substitute, not the prescribed
            // token, found by grepping the real token tree rather than reusing
            // whatever was on hand.
            background: isActive ? Colors.Background.Container.Primary.Default : 'transparent',
          })}
        >
          {n.label}
          {n.to === '/setup' && complete === false && (
            <span
              title="Initial Setup incomplete"
              style={{ width: 8, height: 8, borderRadius: '50%', background: Colors.Charts.Apdex.Unacceptable.Default, flex: '0 0 auto' }}
            />
          )}
        </NavLink>
      ))}
    </Flex>
  );
};

/**
 * DeviceDetail and Diff render as a right-side drawer over whichever list page
 * was showing, using react-router's standard "background location" pattern:
 * the list pages navigate to a detail route with
 * `state: { backgroundLocation: location }`, so the URL changes (shareable,
 * back-button-friendly) while the ROUTES rendered underneath keep showing the
 * page the user was actually on, per the `location` prop below.
 *
 * Visiting a detail route directly (a bookmarked link, no backgroundLocation
 * in state) falls through to the first <Routes> block instead, rendering it
 * as an ordinary full page - there is nothing to show behind a drawer in that
 * case, so it degrades to what it would have been before this change.
 */
export const App = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const backgroundLocation = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;

  return (
    <Flex flexDirection="column">
      <Nav />
      <SetupBanner />
      <Routes location={backgroundLocation ?? location}>
        <Route path="/" element={<Devices />} />
        <Route path="/coverage" element={<Coverage />} />
        <Route path="/changes" element={<Changes />} />
        <Route path="/failures" element={<Failures />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/manage" element={<Manage />} />
        <Route path="/credentials" element={<Credentials />} />
        <Route path="/device/:deviceId" element={<DeviceDetail />} />
        <Route path="/diff/:deviceId" element={<Diff />} />
      </Routes>

      {backgroundLocation && (
        <Routes>
          <Route
            path="/device/:deviceId"
            element={
              <SlideOverDrawer open onClose={() => navigate(-1)}>
                <DeviceDetail />
              </SlideOverDrawer>
            }
          />
          <Route
            path="/diff/:deviceId"
            element={
              <SlideOverDrawer open onClose={() => navigate(-1)}>
                <Diff />
              </SlideOverDrawer>
            }
          />
        </Routes>
      )}
    </Flex>
  );
};
