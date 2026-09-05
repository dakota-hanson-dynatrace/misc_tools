import React from 'react';
import { Routes, Route, NavLink } from 'react-router-dom';
import { Flex } from '@dynatrace/strato-components/layouts';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { Hosts } from './pages/Hosts';
import { Kubernetes } from './pages/Kubernetes';
import { Cloud } from './pages/Cloud';

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

export const App = () => (
  <Flex flexDirection="column">
    <Nav />
    <Routes>
      <Route path="/" element={<Hosts />} />
      <Route path="/kubernetes" element={<Kubernetes />} />
      <Route path="/cloud" element={<Cloud />} />
    </Routes>
  </Flex>
);
