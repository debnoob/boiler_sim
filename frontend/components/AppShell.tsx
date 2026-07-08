'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Gauge,
  LayoutDashboard,
  Moon,
  Sliders,
  TrendingUp,
  UserCircle2,
  type LucideIcon,
} from 'lucide-react';
import { ChatWidget } from './ChatWidget';
import { useNexusStore } from '@/lib/store';
// import { exportToPowerBI } from '@/lib/exportToPowerBI';

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Command',
    items: [
      { href: '/', label: 'Overview', icon: LayoutDashboard },
      { href: '/operations', label: 'Operations', icon: Gauge },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { href: '/predictive', label: 'Predictive Intelligence', icon: TrendingUp },
      { href: '/incidents', label: 'Incidents & Alarms', icon: AlertTriangle },
      { href: '/controls', label: 'Controls', icon: Sliders },
    ],
  },
  {
    label: 'Records',
    items: [
      { href: '/reports', label: 'Reports', icon: FileText },
    ],
  },
];

const NAV = NAV_GROUPS.flatMap((group) => group.items);

const PAGE_TITLES: Record<string, string> = {
  '/': 'Overview',
  '/operations': 'Operations',
  '/predictive': 'Predictive Intelligence',
  '/incidents': 'Incidents & Alarms',
  '/controls': 'Controls',
  '/reports': 'Reports',
};

const MODE_COLORS: Record<string, string> = {
  NORMAL: '#22c55e',
  DEGRADING: '#fbbf24',
  CRITICAL: '#f97316',
  FAULT: '#ef4444',
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { mqttStatus, mode, alerts, toggleTheme, msgCount } = useNexusStore();
  const [clock, setClock] = useState('');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const criticalCount = alerts.filter((a) => a.severity === 'CRITICAL' || a.severity === 'HIGH').length;
  const modeColor = MODE_COLORS[mode] ?? '#22c55e';
  const connected = mqttStatus === 'connected';
  const pageTitle = PAGE_TITLES[pathname] ?? NAV.find((item) => pathname.startsWith(item.href))?.label ?? 'Overview';

  return (
    <div className={`app-layout ${isSidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`app-sidebar ${isSidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="app-sidebar-logo">
          <div className="app-brand-lockup">
            <img src="/logo.png" alt="Nexus OS" className="app-logo-image" />
            <div className="app-logo-copy">
              <div className="app-logo-title">NEXUS OS</div>
              <div className="app-logo-sub">Boiler Intelligence</div>
            </div>
          </div>
          <button
            className="sidebar-icon-button"
            onClick={() => setIsSidebarCollapsed((v) => !v)}
            aria-label={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {isSidebarCollapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
          </button>
        </div>

        <nav className="app-nav" aria-label="Primary navigation">
          {NAV_GROUPS.map((group) => (
            <div className="app-nav-group" key={group.label}>
              <div className="app-nav-section-label">{group.label}</div>
              {group.items.map(({ href, label, icon: Icon }) => {
                const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
                const badge = href === '/incidents' && criticalCount > 0 ? criticalCount : null;
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`app-nav-item ${active ? 'active' : ''}`}
                    title={isSidebarCollapsed ? label : undefined}
                    aria-current={active ? 'page' : undefined}
                  >
                    <Icon size={17} strokeWidth={2.1} className="app-nav-icon" />
                    <span>{label}</span>
                    {badge != null && <strong className="app-nav-badge">{badge}</strong>}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="app-sidebar-asset">
          <div className="app-nav-section-label">Asset Context</div>
          <button className="app-asset-card" title="Boiler Unit 01 asset context">
            <span className="asset-status-dot" style={{ background: modeColor, boxShadow: `0 0 8px ${modeColor}66` }} />
            <Box size={16} strokeWidth={2.1} className="asset-card-icon" />
            <span className="asset-card-copy">
              <strong>Boiler Unit 01</strong>
              <em>Nexus Demo Plant / Pumphouse 4</em>
            </span>
            <ChevronDown size={15} strokeWidth={2.1} className="asset-card-chevron" />
          </button>
        </div>

        <div className="app-sidebar-footer">
          <div className="sidebar-health-card">
            <div>
              <span>MQTT</span>
              <strong className={connected ? 'health-ok' : 'health-bad'}>
                <i className={`sidebar-mqtt-dot ${connected ? 'conn' : 'disc'}`} />
                {mqttStatus}
              </strong>
            </div>
            <div>
              <span>Mode</span>
              <strong style={{ color: modeColor }}>{mode}</strong>
            </div>
            <div>
              <span>Messages</span>
              <strong>{msgCount}</strong>
            </div>
          </div>

          <div className="sidebar-footer-controls">
            <button className="sidebar-theme-button" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
              <Moon size={14} strokeWidth={2.1} />
              <span>Theme</span>
              <span className="theme-toggle" aria-hidden="true" />
            </button>
            <div className="sidebar-operator">
              <UserCircle2 size={20} strokeWidth={1.9} />
              <div>
                <strong>Operator</strong>
                <span>Control room</span>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <div className="app-main">
        <header className="app-topbar">
          <div className="app-topbar-left">
            <div className="app-breadcrumb">
              <span>Nexus Demo Plant</span>
              <span>/</span>
              <span>Pumphouse 4</span>
              <span>/</span>
              <strong>BOILER-01</strong>
            </div>
            <h1>{pageTitle}</h1>
          </div>

          <div className="app-topbar-right">
            <span className="mode-pill" style={{ borderColor: `${modeColor}55`, color: modeColor }}>
              {mode}
            </span>
            <span className="app-clock">{clock}</span>
            {/* <button
              disabled={!tags}
              onClick={() => exportToPowerBI(useNexusStore.getState())}
              style={{ padding: '5px 12px', fontSize: 12, fontWeight: 700, borderRadius: 6, background: '#1e3a5f', color: '#c7dcf5', border: '1px solid #2d5a9e', cursor: tags ? 'pointer' : 'not-allowed', opacity: tags ? 1 : 0.4, whiteSpace: 'nowrap' }}
            >
              ↓ Power BI
            </button> */}
          </div>
        </header>

        <main className="app-content">
          {children}
        </main>
      </div>

      <ChatWidget />
    </div>
  );
}
