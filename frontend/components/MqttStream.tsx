'use client';

import { useEffect, useRef } from 'react';
import { useNexusStore } from '@/lib/store';

const COLOR_MAP = { emerald: '#4ade80', amber: '#fbbf24', red: '#ef4444' };

export function MqttStream() {
  const { streamMessages, msgCount } = useNexusStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [streamMessages]);

  return (
    <div className="mqtt-stream-shell">
      <div className="mqtt-stream-inner">
        <div className="card" style={{ borderColor: 'transparent', background: 'var(--bg-deep)', borderRadius: 13 }}>
          <div
            className="flex items-center gap-2 px-4 py-3 border-b"
            style={{ borderColor: 'var(--bd-stream)', background: 'var(--bg-base)' }}
          >
            <span style={{ color: '#a16207', fontSize: 13 }}>⬡</span>
            <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--tx-muted)' }}>
              MQTT Intelligence Stream
            </span>
            <span className="ml-auto text-[10px]" style={{ color: 'var(--tx-muted)' }}>
              Messages:{' '}
              <span className="font-semibold digit" style={{ color: 'var(--tx-secondary)' }}>
                {msgCount}
              </span>
            </span>
          </div>
          <div
            ref={scrollRef}
            className="px-4 py-3 h-20 overflow-y-auto text-xs space-y-1 mono hide-scrollbar"
            style={{ color: 'var(--tx-secondary)' }}
          >
            {streamMessages.map((msg) => (
              <div key={msg.id} className="slide-in" style={{ color: COLOR_MAP[msg.color] }}>
                {msg.timestamp && (
                  <span style={{ color: 'var(--tx-muted)' }}>[{msg.timestamp}] </span>
                )}
                {msg.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
