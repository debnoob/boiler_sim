'use client';

import { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useNexusStore } from '@/lib/store';
import { AiChat } from './AiChat';

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [pulse, setPulse] = useState(false);
  const prevAiCountRef = useRef(0);
  const { chatMessages, aiStatus } = useNexusStore();

  /* Track new AI/diagnosis messages that arrive while the widget is closed */
  useEffect(() => {
    const aiCount = chatMessages.filter(
      m => m.type === 'diagnosis' || m.type === 'shift_report'
    ).length;

    if (!open && aiCount > prevAiCountRef.current) {
      const newOnes = aiCount - prevAiCountRef.current;
      setUnread(u => u + newOnes);
      setPulse(true);
      const t = setTimeout(() => setPulse(false), 2000);
      return () => clearTimeout(t);
    }
    prevAiCountRef.current = aiCount;
  }, [chatMessages, open]);

  const handleToggle = () => {
    if (!open) setUnread(0);
    setOpen(o => !o);
  };

  const isAnalyzing = aiStatus === 'analyzing';

  return (
    <>
      {/* ── Panel ──────────────────────────────────────────── */}
      <div
        aria-hidden={!open}
        style={{
          position: 'fixed',
          bottom: 88,
          right: 24,
          width: 420,
          maxWidth: 'calc(100vw - 48px)',
          /* let the panel fill available height on small screens */
          maxHeight: 'calc(100vh - 108px)',
          zIndex: 999,
          /* spring-like entrance */
          opacity: open ? 1 : 0,
          transform: open ? 'scale(1) translateY(0)' : 'scale(0.96) translateY(18px)',
          pointerEvents: open ? 'auto' : 'none',
          transition: open
            ? 'opacity 0.18s ease, transform 0.28s cubic-bezier(0.34,1.36,0.64,1)'
            : 'opacity 0.15s ease, transform 0.15s ease',
          transformOrigin: 'bottom right',
          borderRadius: 18,
          overflow: 'hidden',
          /* prominent shadow + amber glow */
          boxShadow: '0 32px 64px -8px rgba(0,0,0,0.75), 0 0 0 1px rgba(161,98,7,0.35), 0 0 40px rgba(161,98,7,0.12)',
        }}
      >
        {/* Close strip at very top of panel */}
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0,
          height: 36,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          paddingRight: 10,
          zIndex: 10,
          background: 'linear-gradient(to bottom, var(--ai-header-bg) 60%, transparent)',
          pointerEvents: 'none',
        }}>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close chat"
            style={{
              pointerEvents: 'auto',
              width: 24, height: 24,
              borderRadius: '50%',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--bd-inner)',
              color: 'var(--tx-muted)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <X size={12} strokeWidth={2.5} />
          </button>
        </div>

        <AiChat />
      </div>

      {/* ── FAB toggle ─────────────────────────────────────── */}
      <button
        onClick={handleToggle}
        aria-label={open ? 'Close AI chat' : 'Open AI chat'}
        style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          zIndex: 1000,
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: open
            ? 'var(--bg-elevated)'
            : 'linear-gradient(140deg, #78350f 0%, #a16207 45%, #ca8a04 100%)',
          border: `2px solid ${open ? 'var(--bd-inner)' : 'rgba(251,191,36,0.45)'}`,
          color: open ? 'var(--tx-secondary)' : '#fef3c7',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          boxShadow: open
            ? '0 4px 14px rgba(0,0,0,0.4)'
            : '0 8px 28px rgba(161,98,7,0.6), 0 2px 8px rgba(0,0,0,0.35)',
          transition: 'all 0.2s ease',
          outline: 'none',
          /* pulse ring when AI is analyzing */
          animation: (isAnalyzing && !open) ? 'fabPulse 1.6s ease-in-out infinite' : 'none',
        }}
      >
        {open
          ? <X size={20} strokeWidth={2.5} />
          : <span style={{ fontSize: 22, lineHeight: 1 }}>⬡</span>
        }

        {/* Unread badge */}
        {!open && unread > 0 && (
          <span style={{
            position: 'absolute',
            top: -5, right: -5,
            minWidth: 20, height: 20,
            borderRadius: 99,
            background: '#ef4444',
            color: '#fff',
            fontSize: 10,
            fontWeight: 800,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 4px',
            border: '2px solid var(--bg-base)',
            animation: pulse ? 'pulseDot 0.5s ease-in-out 3' : 'none',
          }}>
            {unread}
          </span>
        )}

        {/* Analyzing indicator dot */}
        {!open && isAnalyzing && (
          <span style={{
            position: 'absolute',
            bottom: 2, right: 2,
            width: 10, height: 10,
            borderRadius: '50%',
            background: '#fbbf24',
            border: '2px solid var(--bg-base)',
            animation: 'pulseDot 1s ease-in-out infinite',
          }} />
        )}
      </button>

      {/* Keyframe for the FAB pulse ring */}
      <style>{`
        @keyframes fabPulse {
          0%,100% { box-shadow: 0 8px 28px rgba(161,98,7,0.6), 0 2px 8px rgba(0,0,0,0.35), 0 0 0 0 rgba(251,191,36,0.5); }
          50%      { box-shadow: 0 8px 28px rgba(161,98,7,0.6), 0 2px 8px rgba(0,0,0,0.35), 0 0 0 10px rgba(251,191,36,0); }
        }
      `}</style>
    </>
  );
}
