'use client';

import { useEffect, useRef } from 'react';
import { useNexusStore } from '@/lib/store';

const DOT_CLASS: Record<string, string> = {
  CRITICAL: 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.8)]',
  HIGH: 'bg-orange-500 shadow-[0_0_10px_rgba(249,115,22,0.8)]',
  WARNING: 'bg-amber-500',
  LOW: 'bg-amber-500',
};
const TEXT_CLASS: Record<string, string> = {
  CRITICAL: 'text-red-400',
  HIGH: 'text-orange-400',
  WARNING: 'text-amber-400',
  LOW: 'text-amber-400',
};

export function AlertTimeline() {
  const { alerts } = useNexusStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [alerts]);

  const hasAlerts = alerts.length > 0;

  return (
    <div id="auto-card" className="card">
      <div className="card-header flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--bd-inner)', color: 'var(--tx-secondary)' }}>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-bold" style={{ color: 'var(--tx-primary)' }}>Alert / Event Timeline</h2>
            <p className="text-xs font-medium" style={{ color: 'var(--tx-secondary)' }}>Real-time sequence of operational events</p>
          </div>
        </div>
        <div
          className={`text-xs px-3 py-1.5 rounded-md font-medium tracking-wide ${hasAlerts ? 'bg-red-500 text-white animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.5)]' : ''}`}
          style={hasAlerts ? {} : { background: 'var(--bg-elevated)', color: 'var(--tx-secondary)', border: '1px solid var(--bd-inner)' }}
        >
          {hasAlerts ? 'ACTIVE' : 'MONITORING'}
        </div>
      </div>

      {/* Timeline strip */}
      <div
        ref={scrollRef}
        className="p-6 relative overflow-x-auto overflow-y-hidden whitespace-nowrap scroll-smooth"
        style={{ scrollbarWidth: 'thin', scrollbarColor: '#3f3f46 transparent' }}
      >
        {/* Center line */}
        <div className="absolute top-1/2 left-6 right-6 h-[1px] -translate-y-1/2 z-0" style={{ background: 'var(--bd-card)' }} />

        {/* Items */}
        <div className="relative z-10 flex items-center min-w-full h-24 gap-6 px-2">
          {!hasAlerts ? (
            <div
              className="text-sm italic whitespace-nowrap px-3 py-1 rounded-md"
              style={{ color: 'var(--tx-secondary)', background: 'var(--bg-elevated)', border: '1px solid var(--bd-inner)' }}
            >
              Listening for alerts on factory/pumphouse4/boiler/unit01/alerts...
            </div>
          ) : (
            alerts.map((alert) => {
              const time = new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              const dotClass = DOT_CLASS[alert.severity] || 'bg-amber-500';
              const textClass = TEXT_CLASS[alert.severity] || 'text-amber-400';
              return (
                <div key={alert.id} className="relative flex flex-col items-center flex-shrink-0 group slide-in w-24 hover:z-50">
                  {/* Tooltip */}
                  <div
                    className="absolute -top-10 whitespace-nowrap text-[10px] px-2 py-1 rounded shadow-xl opacity-0 group-hover:opacity-100 transition-opacity z-50 pointer-events-none"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--bd-inner)', color: 'var(--tx-primary)' }}
                  >
                    <span className={`font-bold ${textClass}`}>{alert.severity}</span> • {alert.tag} = {alert.value.toFixed(1)}
                  </div>
                  {/* Dot */}
                  <div className={`w-4 h-4 rounded-full z-10 ${dotClass}`} style={{ border: '2px solid var(--bg-base)' }} />
                  {/* Label */}
                  <div className="absolute top-6 w-32 text-center flex flex-col items-center">
                    <div className="text-[9px] font-bold tracking-wider" style={{ color: 'var(--tx-secondary)' }}>{time}</div>
                    <div
                      className="text-[9px] leading-tight mt-0.5 max-w-[120px] line-clamp-2 truncate"
                      style={{ color: 'var(--tx-muted)' }}
                      title={alert.message}
                    >
                      {alert.message}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
