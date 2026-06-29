'use client';

import { useEffect, useState } from 'react';
import { useNexusStore } from '@/lib/store';
import { exportToPowerBI } from '@/lib/exportToPowerBI';

const MODE_COLORS: Record<string, string> = {
  NORMAL: '#4ade80',
  DEGRADING: '#fbbf24',
  CRITICAL: '#f97316',
  FAULT: '#ef4444',
};

export function Header() {
  const { mqttStatus, mode, msgCount, toggleTheme, isLight, tags } = useNexusStore();
  const [clock, setClock] = useState('');

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const connected = mqttStatus === 'connected';

  return (
    <div className="flex justify-between items-center mb-8">
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div
          className="w-12 h-12 flex items-center justify-center text-lg font-black rounded-xl flex-shrink-0"
          style={{ background: '#a16207', color: '#09090b', letterSpacing: '-1px' }}
        >
          Nx
        </div>
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight" style={{ color: 'var(--accent-text)', letterSpacing: '-0.03em' }}>
            NEXUS OS
          </h1>
          <div className="flex items-center gap-3 mt-1.5">
            {/* MQTT status */}
            {connected ? (
              <span className="text-emerald-400 flex items-center gap-1.5 text-xs font-medium">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75 pulse-dot" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                LIVE • MQTT CONNECTED
              </span>
            ) : (
              <span className="text-red-500 flex items-center gap-1.5 text-xs font-medium">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75 pulse-dot" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                </span>
                {mqttStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}
              </span>
            )}
            <span className="text-zinc-500 text-xs font-medium">
              BOILER-01 · <span className="digit">{clock}</span>
            </span>
            <span className="text-zinc-500 text-xs font-medium">
              Mode:{' '}
              <span
                id="mode-display"
                className="font-semibold"
                style={{ color: MODE_COLORS[mode] || 'var(--accent)' }}
              >
                {mode}
              </span>
            </span>
          </div>
        </div>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-3">
        <span className="text-xs font-mono" style={{ color: 'var(--tx-muted)' }}>
          {msgCount} msgs
        </span>
        <button
          className="px-4 py-2 text-sm font-bold rounded-md transition-colors"
          style={{ background: '#a16207', color: '#09090b' }}
        >
          Dashboard
        </button>
        <button
          className="px-4 py-2 border text-sm font-medium rounded-md transition-colors"
          style={{ borderColor: 'var(--bd-card)', color: 'var(--tx-secondary)', background: 'transparent' }}
          onMouseOver={(e) => (e.currentTarget.style.background = 'var(--bg-elevated)')}
          onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          Settings
        </button>
        <button
          disabled={!tags}
          onClick={() => exportToPowerBI(useNexusStore.getState())}
          className="px-4 py-2 text-sm font-bold rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: '#1e3a5f', color: '#c7dcf5', border: '1px solid #2d5a9e' }}
          title={tags ? 'Export dashboard data to Power BI (.xlsx)' : 'Waiting for live data…'}
          onMouseOver={(e) => { if (tags) e.currentTarget.style.background = '#254a7a'; }}
          onMouseOut={(e) => { e.currentTarget.style.background = '#1e3a5f'; }}
        >
          ↓ Power BI
        </button>
        {/* Theme toggle */}
        <div className="flex items-center gap-2 ml-1" title="Toggle light / dark">
          <span style={{ fontSize: 12, color: 'var(--tx-muted)' }}>🌙</span>
          <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme" />
          <span style={{ fontSize: 12, color: 'var(--tx-muted)' }}>☀️</span>
        </div>
      </div>
    </div>
  );
}
