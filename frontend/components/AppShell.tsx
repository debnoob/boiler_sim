'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LayoutDashboard, TrendingUp, AlertTriangle, Sliders, FileText, Menu, ArrowLeft } from 'lucide-react';
import { ChatWidget } from './ChatWidget';
import { useNexusStore } from '@/lib/store';
import { exportToPowerBI } from '@/lib/exportToPowerBI';

const NAV = [
  { href: '/',           label: 'Overview',                icon: LayoutDashboard },
  { href: '/predictive', label: 'Predictive Intelligence', icon: TrendingUp },
  { href: '/incidents',  label: 'Incidents & Alarms',      icon: AlertTriangle },
  { href: '/controls',   label: 'Controls',                icon: Sliders },
  { href: '/reports',    label: 'Reports',                 icon: FileText },
] as const;

const PAGE_TITLES: Record<string, string> = {
  '/':           'Overview',
  '/predictive': 'Predictive Intelligence',
  '/incidents':  'Incidents & Alarms',
  '/controls':   'Controls',
  '/reports':    'Reports',
};

const MODE_COLORS: Record<string, string> = {
  NORMAL: '#22c55e', DEGRADING: '#fbbf24', CRITICAL: '#f97316', FAULT: '#ef4444',
};

const SIDEBAR_W = 220;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { mqttStatus, mode, alerts, tags, toggleTheme } = useNexusStore();
  const [clock, setClock] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const criticalCount = alerts.filter(a => a.severity === 'CRITICAL' || a.severity === 'HIGH').length;
  const modeColor = MODE_COLORS[mode] ?? '#22c55e';
  const connected = mqttStatus === 'connected';
  const pageTitle = PAGE_TITLES[pathname] ?? 'Overview';

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-base)' }}>

      {/* ── Sidebar ─────────────────────────────────────────── */}
      <aside style={{
        width: SIDEBAR_W,
        flexShrink: 0,
        position: 'fixed',
        top: 0, bottom: 0, left: 0,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--bd-card)',
        overflowY: 'auto',
        transform: isSidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
        transition: 'transform 0.3s ease',
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 16px 14px', borderBottom: '1px solid var(--bd-inner)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 34, height: 34, borderRadius: 8,
              background: '#a16207', color: '#09090b',
              fontWeight: 900, fontSize: 13, letterSpacing: -1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>Nx</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--accent-text)', letterSpacing: '-0.02em' }}>NEXUS OS</div>
              <div style={{ fontSize: 10, color: 'var(--tx-muted)', fontWeight: 500, marginTop: 1 }}>Boiler Intelligence</div>
            </div>
          </div>
          <button 
            onClick={() => setIsSidebarOpen(false)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tx-secondary)', display: 'flex', padding: 4, borderRadius: 4 }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-elevated)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
          >
            <ArrowLeft size={18} />
          </button>
        </div>

        {/* Nav */}
        <nav style={{ padding: '10px 8px', flex: 1 }}>
          <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--tx-muted)', padding: '4px 10px 8px' }}>
            Operations
          </div>
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
            const isHov = hovered === href;
            const badge = href === '/incidents' && criticalCount > 0 ? criticalCount : null;
            return (
              <Link
                key={href}
                href={href}
                onMouseEnter={() => setHovered(href)}
                onMouseLeave={() => setHovered(null)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9,
                  padding: '8px 10px', borderRadius: 7,
                  fontSize: 13, fontWeight: 600,
                  color: active ? '#fbbf24' : isHov ? 'var(--tx-primary)' : 'var(--tx-secondary)',
                  textDecoration: 'none', marginBottom: 1,
                  background: active ? 'rgba(161,98,7,0.14)' : isHov ? 'var(--bg-elevated)' : 'transparent',
                  border: `1px solid ${active ? 'rgba(161,98,7,0.28)' : 'transparent'}`,
                  transition: 'all 0.12s',
                }}
              >
                <Icon size={15} strokeWidth={2} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
                {badge != null && (
                  <span style={{
                    minWidth: 18, height: 18, padding: '0 5px', borderRadius: 99,
                    background: '#ef4444', color: '#fff',
                    fontSize: 9, fontWeight: 800,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>{badge}</span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Asset context */}
        <div style={{ padding: '12px 8px', borderTop: '1px solid var(--bd-inner)' }}>
          <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--tx-muted)', padding: '4px 10px 8px' }}>
            Asset Context
          </div>
          <div style={{ fontSize: 11.5, padding: '3px 10px', color: 'var(--tx-label)', fontWeight: 700 }}>Nexus Demo Plant</div>
          <div style={{ fontSize: 11.5, padding: '3px 20px', color: 'var(--tx-secondary)' }}>Pumphouse 4</div>
          <div style={{ fontSize: 11.5, padding: '5px 10px', color: '#fbbf24', fontWeight: 700, background: 'rgba(161,98,7,0.10)', borderRadius: 6, margin: '2px 4px' }}>
            ⬡ Boiler Unit 01
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '10px 16px', borderTop: '1px solid var(--bd-inner)', fontSize: 10, fontWeight: 600, color: 'var(--tx-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: connected ? '#22c55e' : '#ef4444', boxShadow: connected ? '0 0 6px #22c55e88' : 'none' }} />
          <span>MQTT {mqttStatus.toUpperCase()}</span>
        </div>
      </aside>

      {/* ── Main ─────────────────────────────────────────────── */}
      <div style={{ marginLeft: isSidebarOpen ? SIDEBAR_W : 0, transition: 'margin-left 0.3s ease', flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>

        {/* Top bar */}
        <header style={{
          position: 'sticky', top: 0, zIndex: 40,
          height: 56, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 24px', gap: 16,
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--bd-card)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
            {!isSidebarOpen && (
              <button 
                onClick={() => setIsSidebarOpen(true)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tx-primary)', display: 'flex', padding: 4, borderRadius: 4 }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-elevated)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
              >
                <Menu size={20} />
              </button>
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--tx-muted)', fontWeight: 500, marginBottom: 2 }}>
              <span>Nexus Demo Plant</span>
              <span style={{ opacity: 0.4 }}>/</span>
              <span>Pumphouse 4</span>
              <span style={{ opacity: 0.4 }}>/</span>
              <span style={{ color: 'var(--tx-secondary)', fontWeight: 700 }}>BOILER-01</span>
            </div>
            <h1 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: 'var(--tx-primary)', letterSpacing: '-0.02em' }}>
              {pageTitle}
            </h1>
          </div>
        </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', padding: '3px 10px', borderRadius: 99, border: `1px solid ${modeColor}55`, color: modeColor, textTransform: 'uppercase' }}>
              {mode}
            </span>
            <span style={{ fontSize: 11, color: 'var(--tx-muted)', fontVariantNumeric: 'tabular-nums' }}>{clock}</span>
            <button
              disabled={!tags}
              onClick={() => exportToPowerBI(useNexusStore.getState())}
              style={{ padding: '5px 12px', fontSize: 12, fontWeight: 700, borderRadius: 6, background: '#1e3a5f', color: '#c7dcf5', border: '1px solid #2d5a9e', cursor: tags ? 'pointer' : 'not-allowed', opacity: tags ? 1 : 0.4, whiteSpace: 'nowrap' }}
            >
              ↓ Power BI
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--tx-muted)' }}>🌙</span>
              <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme" />
              <span style={{ fontSize: 11, color: 'var(--tx-muted)' }}>☀️</span>
            </div>
          </div>
        </header>

        {/* Page content */}
        <main style={{ flex: 1, overflowY: 'auto', padding: 24, background: 'var(--bg-base)' }}>
          {children}
        </main>
      </div>

      {/* Floating AI chat widget — always visible */}
      <ChatWidget />
    </div>
  );
}
