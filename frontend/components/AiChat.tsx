'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { AlertCircle, BookOpen, Check, CheckCircle, ChevronLeft, ChevronRight, Cpu, FileText, Flag, FlaskConical, HelpCircle, Loader2, MessageSquareText, MoreHorizontal, RefreshCw, SearchX, Send, ShieldAlert, Upload, Wrench, X } from 'lucide-react';
import { useNexusStore } from '@/lib/store';
import { usePublish } from '@/lib/publishContext';
import { formatRich, preprocessMessage, normalizeToString } from '@/lib/utils';
import type { ChatMessage, DiagnosisPayload, AiResponsePayload } from '@/types/telemetry';

const SEVERITY_BADGE: Record<string, string> = {
  critical: '#ef4444', high: '#f97316', warning: '#f59e0b',
  medium: '#eab308', low: '#3b82f6', normal: '#22c55e',
};

const AI_FEEDBACK_TOPIC = 'factory/pumphouse4/boiler/unit01/ai/feedback';

type UploadState = 'idle' | 'uploading' | 'done' | 'error';
interface KbDoc { filename: string; doc_id: string; chunks_stored?: number; }

interface AiChatProps {
  variant?: 'panel' | 'floating';
}

export function AiChat({ variant = 'panel' }: AiChatProps) {
  const publish = usePublish();
  const { chatMessages, aiStatus, addChatMessage, woCount, tags, anomalyScore, mode } = useNexusStore();
  const [input, setInput] = useState('');
  const [thinkingDots, setThinkingDots] = useState('');
  const [chipsScrollLeft, setChipsScrollLeft] = useState(0);
  const [chipsScrollable, setChipsScrollable] = useState(false);
  const [morePromptsOpen, setMorePromptsOpen] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [uploadLabel, setUploadLabel] = useState('');
  const [kbDocs, setKbDocs] = useState<KbDoc[]>([]);
  const [kbOpen, setKbOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const phaseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const showThinking = chatMessages.some(m => m.id === 'thinking');

  // Auto-scroll messages
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [chatMessages]);

  // Compact analyzing indicator
  useEffect(() => {
    if (showThinking) {
      phaseTimerRef.current = setInterval(() => {
        setThinkingDots(d => d.length >= 3 ? '' : d + '.');
      }, 900);
    } else {
      if (phaseTimerRef.current) clearInterval(phaseTimerRef.current);
      setThinkingDots('');
    }
    return () => { if (phaseTimerRef.current) clearInterval(phaseTimerRef.current); };
  }, [showThinking]);

  // Chips overflow detection
  useEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    const check = () => setChipsScrollable(el.scrollWidth > el.clientWidth + 4);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Knowledge base: fetch loaded manuals from RAG server
  const fetchKbDocs = useCallback(async () => {
    try {
      const resp = await fetch('/api/rag-docs');
      if (!resp.ok) return;
      const data = await resp.json();
      setKbDocs(data.documents ?? []);
    } catch { /* RAG server offline — silently skip */ }
  }, []);

  useEffect(() => { fetchKbDocs(); }, [fetchKbDocs]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setUploadState('uploading');
    setUploadLabel(file.name.length > 22 ? file.name.slice(0, 20) + '…' : file.name);

    const form = new FormData();
    form.append('file', file);

    try {
      const resp = await fetch('/api/upload-pdf', { method: 'POST', body: form });
      const data = await resp.json();

      if (!resp.ok) {
        setUploadState('error');
        setUploadLabel(data.error ?? 'Upload failed');
        addChatMessage({
          id: `sys-${Date.now()}`,
          type: 'ai',
          content: `Failed to ingest **${file.name}**: ${data.error ?? 'Unknown error'}`,
          timestamp: new Date().toLocaleTimeString(),
        });
      } else {
        setUploadState('done');
        setUploadLabel(`${file.name} (${data.chunks_stored} chunks)`);
        addChatMessage({
          id: `sys-${Date.now()}`,
          type: 'ai',
          content: `Manual ingested: **${data.filename}** — ${data.chunks_stored} chunks stored in the knowledge base. You can now ask questions about it.`,
          timestamp: new Date().toLocaleTimeString(),
        });
        fetchKbDocs();
        setKbOpen(true);
      }
    } catch {
      setUploadState('error');
      setUploadLabel('RAG server offline');
      addChatMessage({
        id: `sys-${Date.now()}`,
        type: 'ai',
        content: 'Could not reach the RAG server. Make sure `rag_server.py` is running on port 8001.',
        timestamp: new Date().toLocaleTimeString(),
      });
    }

    setTimeout(() => { setUploadState('idle'); setUploadLabel(''); }, 4000);
  }, [addChatMessage]);

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    addChatMessage({ id: `user-${Date.now()}`, type: 'user', content: text, timestamp: new Date().toLocaleTimeString() });
    setInput('');
    publish('factory/pumphouse4/boiler/unit01/ai/question', { question: text, timestamp: new Date().toISOString() });
    addChatMessage({ id: 'thinking', type: 'thinking', content: '', timestamp: '' });
  }, [input, addChatMessage, publish]);

  const sendQuick = (q: string) => {
    setInput(q);
    setTimeout(() => {
      addChatMessage({ id: `user-${Date.now()}`, type: 'user', content: q, timestamp: new Date().toLocaleTimeString() });
      publish('factory/pumphouse4/boiler/unit01/ai/question', { question: q, timestamp: new Date().toISOString() });
      addChatMessage({ id: 'thinking', type: 'thinking', content: '', timestamp: '' });
      setInput('');
    }, 0);
  };

  const sendShiftReport = () => {
    addChatMessage({ id: `user-${Date.now()}`, type: 'user', content: 'Generate the end-of-shift report', timestamp: new Date().toLocaleTimeString() });
    publish('factory/pumphouse4/boiler/unit01/ai/question', { type: 'shift_report', timestamp: new Date().toISOString() });
    addChatMessage({ id: 'thinking', type: 'thinking', content: '', timestamp: '' });
  };

  function scrollChips(dir: number) {
    chipsRef.current?.scrollBy({ left: dir * 140, behavior: 'smooth' });
  }

  function updateChipsScroll() {
    setChipsScrollLeft(chipsRef.current?.scrollLeft ?? 0);
  }

  const primaryQuickPrompts = [
    ['Health check', 'Run a full health check on the boiler right now. Anything I should worry about?'],
    ['Explain anomaly', 'Explain the latest anomaly using current sensor values and baseline differences.'],
    ['OEE status', 'Calculate current shift OEE and show availability, thermal performance, and quality factors.'],
  ];
  const secondaryQuickPrompts = [
    ['Compare baseline', 'Compare current live telemetry against normal operating baseline and call out deviations.'],
    ['Predict failure', 'Based on the live telemetry, what is most likely to fail next and when should we intervene?'],
    ['Maintenance priority', 'What should the maintenance team prioritize this week, in order?'],
  ];

  const atStart = chipsScrollLeft <= 4;
  const atEnd = chipsRef.current ? chipsScrollLeft >= (chipsRef.current.scrollWidth - chipsRef.current.clientWidth - 4) : true;
  const livePressure = tags?.steam_pressure;
  const liveEfficiency = tags?.efficiency;
  const pressureTone = livePressure == null ? 'neutral' : livePressure > 13 ? 'crit' : livePressure > 12 ? 'warn' : 'ok';
  const efficiencyTone = liveEfficiency == null ? 'neutral' : liveEfficiency < 75 ? 'crit' : liveEfficiency < 82 ? 'warn' : 'ok';
  const pressureText = livePressure == null ? '--' : `${livePressure.toFixed(1)} bar`;
  const efficiencyText = liveEfficiency == null ? '--' : `${liveEfficiency.toFixed(1)}%`;

  return (
    <div className={`ai-chat-shell ${aiStatus === 'analyzing' ? 'ai-chat-shell-active' : ''} ${variant === 'floating' ? 'ai-chat-shell-floating' : ''}`}>
      <div className="ai-chat-card">

        {/* Header */}
        <div className="ai-widget-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div style={{ position: 'relative', width: 30, height: 30 }}>
              <div style={{ position: 'relative', width: 30, height: 30, borderRadius: 7, border: '1.5px solid var(--accent)', background: 'var(--ai-chip-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-text)' }}>
                <Cpu size={15} strokeWidth={2.2} />
              </div>
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--tx-primary)', letterSpacing: '0' }}>Nexus AI</div>
            </div>
          </div>
          {aiStatus === 'analyzing' ? (
            <div className="status-pill warn">
              <RefreshCw size={11} color="#fbbf24" />
              <span>Analyzing</span>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: 'rgba(16,185,129,0.1)', border: '1px solid #166534' }}>
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75 pulse-dot" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span style={{ color: '#4ade80' }}>Online</span>
            </div>
          )}
        </div>

        <div className="ai-shimmer-line" />

        {false && variant === 'floating' && (
          <div className="ai-live-context" aria-label="Live boiler context">
            <LiveContextItem label="Mode" value={mode} tone={mode === 'NORMAL' ? 'ok' : mode === 'FAULT' ? 'crit' : 'warn'} />
            <LiveContextItem label="PRS" value={pressureText} tone={pressureTone} />
            <LiveContextItem label="EFF" value={efficiencyText} tone={efficiencyTone} />
            <LiveContextItem label="ANOM" value={`${anomalyScore}%`} tone={anomalyScore > 70 ? 'crit' : anomalyScore > 30 ? 'warn' : 'ok'} />
          </div>
        )}

        {/* Messages */}
        <div ref={messagesRef} className="ai-messages-area hide-scrollbar">
          {chatMessages.map((msg, index) => {
            const priorUser = [...chatMessages.slice(0, index)].reverse().find((m) => m.type === 'user');
            return (
              <ChatBubble
                key={msg.id}
                msg={msg}
                priorQuestion={priorUser?.content || ''}
                thinkingDots={thinkingDots}
                woCount={woCount}
              />
            );
          })}
        </div>

        {/* Knowledge Base panel */}
        <div className="ai-kb-drawer">
          <button
            onClick={() => setKbOpen(o => !o)}
            className="ai-kb-toggle"
            title="Manual knowledge base"
          >
            <BookOpen size={13} />
            <span>Manuals</span>
            {kbDocs.length > 0 && (
              <span className="ai-kb-count">{kbDocs.length}</span>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.5 }}>{kbOpen ? 'Hide' : 'Show'}</span>
          </button>
          {kbOpen && (
            <div style={{ padding: '0 14px 8px' }}>
              {kbDocs.length === 0 ? (
                <p style={{ fontSize: 11, color: 'var(--tx-muted)', fontStyle: 'italic', margin: '2px 0 0' }}>
                  No manuals loaded — upload a PDF to ground answers in your documentation.
                </p>
              ) : kbDocs.map(doc => (
                <div key={doc.doc_id} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0',
                  borderBottom: '1px solid var(--ai-bubble-bd)',
                }}>
              <FileText size={13} style={{ flexShrink: 0, color: 'var(--accent-text)' }} />
                  <span style={{ fontSize: 11, color: 'var(--tx-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {doc.filename}
                  </span>
                  {doc.chunks_stored != null && (
                    <span style={{
                      flexShrink: 0, fontSize: 10, padding: '1px 5px', borderRadius: 4,
                      background: 'rgba(74,222,128,0.1)', color: '#4ade80', border: '1px solid rgba(74,222,128,0.2)',
                    }}>{doc.chunks_stored} chunks</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quick chips */}
        <div className="relative" style={{ padding: '8px 14px 6px', background: 'var(--ai-msg-bg)', borderTop: '1px solid var(--ai-bubble-bd)' }}>
          {chipsScrollable && !atStart && (
            <button onClick={() => scrollChips(-1)} style={{ position: 'absolute', left: 4, top: '50%', transform: 'translateY(-50%)', zIndex: 20, width: 22, height: 22, borderRadius: '50%', background: 'var(--ai-chip-bg)', border: '1px solid var(--accent)', color: 'var(--accent-text)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><ChevronLeft size={14} /></button>
          )}
          {chipsScrollable && !atEnd && (
            <>
              <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 36, pointerEvents: 'none', zIndex: 10, background: 'linear-gradient(to right, transparent, var(--ai-msg-bg))' }} />
              <button onClick={() => scrollChips(1)} style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', zIndex: 20, width: 22, height: 22, borderRadius: '50%', background: 'var(--ai-chip-bg)', border: '1px solid var(--accent)', color: 'var(--accent-text)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><ChevronRight size={14} /></button>
            </>
          )}
          <div ref={chipsRef} className="flex gap-2 overflow-x-auto hide-scrollbar" onScroll={updateChipsScroll}>
            {primaryQuickPrompts.map(([label, q]) => (
              <button key={label} className="ai-chip" onClick={() => sendQuick(q)}>{label}</button>
            ))}
            <button className="ai-chip ai-chip-more" onClick={() => setMorePromptsOpen(o => !o)} title="More quick prompts">
              <MoreHorizontal size={14} />
              <span>More</span>
            </button>
          </div>
          {morePromptsOpen && (
            <div className="ai-more-prompts">
              {secondaryQuickPrompts.map(([label, q]) => (
                <button key={label} onClick={() => { sendQuick(q); setMorePromptsOpen(false); }}>{label}</button>
              ))}
              <button onClick={() => { sendShiftReport(); setMorePromptsOpen(false); }}>Shift report</button>
            </div>
          )}
        </div>

        {/* Input */}
        <div style={{ padding: '8px 14px 12px', background: 'var(--ai-msg-bg)' }}>
          <div className="ai-input-wrap">
            <textarea
              rows={1}
              placeholder="Ask about the plant…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            />
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              style={{ display: 'none' }}
              onChange={handleFileUpload}
            />
            {/* PDF upload button */}
            <button
              title="Upload boiler manual (PDF)"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadState === 'uploading'}
              style={{
                flexShrink: 0,
                width: 28,
                height: 28,
                borderRadius: 7,
                border: `1px solid ${uploadState === 'error' ? '#ef4444' : uploadState === 'done' ? '#4ade80' : 'var(--bd-inner)'}`,
                background: uploadState === 'uploading' ? 'rgba(251,191,36,0.1)' : 'var(--ai-chip-bg)',
                color: uploadState === 'error' ? '#ef4444' : uploadState === 'done' ? '#4ade80' : 'var(--tx-muted)',
                fontSize: 13,
                cursor: uploadState === 'uploading' ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.2s',
              }}
            >
              {uploadState === 'uploading' ? <Loader2 size={14} className="spin-icon" /> : uploadState === 'done' ? <CheckCircle size={14} /> : uploadState === 'error' ? <AlertCircle size={14} /> : <Upload size={14} />}
            </button>
            <button className="ai-send-btn" onClick={sendMessage} aria-label="Send message" title="Send message">
              <Send size={15} strokeWidth={2.4} />
            </button>
          </div>
          {/* Upload status label */}
          {uploadLabel && (
            <p style={{
              textAlign: 'center',
              marginTop: 4,
              fontSize: 10,
              color: uploadState === 'error' ? '#ef4444' : uploadState === 'done' ? '#4ade80' : '#fbbf24',
              transition: 'all 0.3s',
            }}>
              {uploadState === 'uploading' && 'Ingesting '}
              {uploadState === 'done' && 'Stored '}
              {uploadState === 'error' && 'Error '}
              {uploadLabel}
            </p>
          )}

        </div>
      </div>
    </div>
  );
}

function LiveContextItem({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'warn' | 'crit' | 'neutral' }) {
  const color = tone === 'ok' ? '#4ade80' : tone === 'warn' ? '#fbbf24' : tone === 'crit' ? '#f87171' : 'var(--tx-secondary)';
  return (
    <div className="ai-live-context-item">
      <span>{label}</span>
      <strong style={{ color }}>{value}</strong>
    </div>
  );
}

function AiAvatar() {
  return (
    <div className="ai-avatar">
      <Cpu size={14} strokeWidth={2.2} />
    </div>
  );
}

function stringifyFeedbackAnswer(msg: ChatMessage) {
  if (msg.content) return msg.content;
  if (msg.data) return JSON.stringify(msg.data);
  return '';
}

function ChatBubble({
  msg,
  priorQuestion,
  thinkingDots,
  woCount,
}: {
  msg: ChatMessage;
  priorQuestion: string;
  thinkingDots: string;
  woCount: number;
}) {
  const publish = usePublish();
  const { mode, anomalyScore, tags } = useNexusStore();
  const [feedbackSent, setFeedbackSent] = useState<string | null>(null);
  const [typedContent, setTypedContent] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const canSendFeedback = Boolean(priorQuestion) && !['user', 'thinking'].includes(msg.type);

  const sendFeedback = (feedbackType: 'wrong' | 'unsafe' | 'missing_evidence' | 'unclear' | 'custom', note = '') => {
    if (!canSendFeedback) return;
    publish(AI_FEEDBACK_TOPIC, {
      feedback_type: feedbackType,
      question: priorQuestion,
      answer: stringifyFeedbackAnswer(msg),
      answer_type: msg.type,
      message_id: msg.id,
      note,
      timestamp: new Date().toISOString(),
      context: {
        mode,
        anomaly_score: anomalyScore,
      },
    });
    setFeedbackSent(feedbackType);
  };

  useEffect(() => {
    if (msg.type === 'ai' && msg.content) {
      setTypedContent('');
      setIsTyping(true);
      const chars = msg.content;
      let idx = 0;

      const tick = () => {
        idx = Math.min(idx + 4, chars.length);
        setTypedContent(chars.slice(0, idx));
        if (idx >= chars.length) {
          setIsTyping(false);
        }
      };
      timerRef.current = setInterval(tick, 12);
      return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }
  }, [msg.id, msg.content]);

  if (msg.type === 'thinking') {
    return (
      <div className="flex items-start gap-2 slide-in">
        <AiAvatar />
        <div className="ai-bubble ai-thinking-card ai-thinking-compact">
          <span className="ai-thinking-dot" />
          <span>Analyzing live telemetry{thinkingDots}</span>
        </div>
      </div>
    );
  }

  if (msg.type === 'user') {
    return (
      <div className="flex justify-end slide-in">
        <div className="user-bubble">{msg.content}</div>
      </div>
    );
  }

  if (msg.type === 'diagnosis') {
    return (
      <div className="flex items-start gap-2 slide-in">
        <AiAvatar />
        <div style={{ flex: 1, minWidth: 0 }}>
          <DiagnosisCard data={msg.data as DiagnosisPayload} woCount={woCount} ts={msg.timestamp} />
          <FeedbackControls canSend={canSendFeedback} sent={feedbackSent} onSend={sendFeedback} />
        </div>
      </div>
    );
  }

  if (msg.type === 'shift_report') {
    return (
      <div className="flex items-start gap-2 slide-in">
        <AiAvatar />
        <div style={{ flex: 1, minWidth: 0 }}>
          <ShiftReportCard data={msg.data as AiResponsePayload} ts={msg.timestamp} />
          <FeedbackControls canSend={canSendFeedback} sent={feedbackSent} onSend={sendFeedback} />
        </div>
      </div>
    );
  }

  if (msg.type === 'what_if') {
    return (
      <div className="flex items-start gap-2 slide-in">
        <AiAvatar />
        <div style={{ flex: 1, minWidth: 0 }}>
          <WhatIfCard data={msg.data as AiResponsePayload} ts={msg.timestamp} />
          <FeedbackControls canSend={canSendFeedback} sent={feedbackSent} onSend={sendFeedback} />
        </div>
      </div>
    );
  }

  if (msg.type === 'maintenance_priorities') {
    return (
      <div className="flex items-start gap-2 slide-in">
        <AiAvatar />
        <div style={{ flex: 1, minWidth: 0 }}>
          <MaintenancePrioritiesCard data={msg.data as AiResponsePayload} ts={msg.timestamp} />
          <FeedbackControls canSend={canSendFeedback} sent={feedbackSent} onSend={sendFeedback} />
        </div>
      </div>
    );
  }

  if (msg.type === 'learning_feedback') {
    const data = msg.data as AiResponsePayload | undefined;
    const accepted = data?.accepted !== false;
    return (
      <div className={`ai-feedback-toast ${accepted ? '' : 'ignored'} slide-in`}>
        {accepted ? <Check size={13} strokeWidth={2.8} /> : <X size={13} strokeWidth={2.8} />}
        <span>{accepted ? 'Feedback noted' : 'Feedback ignored'}</span>
      </div>
    );
  }

  // AI typed message — rendered as rich markdown
  const rawContent = isTyping ? typedContent : msg.content;
  // 1. Pre-process: convert tables → bullets, strip HR lines, normalise blank lines
  const displayContent = preprocessMessage(rawContent);
  // 2. Split into lines for rendering
  const allLines = displayContent.split('\n').filter(l => l.trim());

  return (
    <div className="flex items-start gap-2 slide-in">
      <AiAvatar />
      <div className="ai-bubble ai-rich-msg">
        {allLines.map((line, i) => {
          const isBullet = /^[-*•]\s/.test(line) || /^\d+\.\s/.test(line);
          const isHeader = /^#{1,3}\s/.test(line);
          return (
            <div
              key={i}
              className={isBullet ? 'ai-bullet-line' : isHeader ? 'ai-header-line' : 'ai-para-line'}
              style={{ marginBottom: i < allLines.length - 1 ? (isHeader ? 8 : isBullet ? 3 : 7) : 0 }}
              dangerouslySetInnerHTML={{
                __html: formatRich(line) + (isTyping && i === allLines.length - 1 ? '<span class="type-cursor"></span>' : '')
              }}
            />
          );
        })}
        {!isTyping && (
          <p className="bubble-time">Nexus AI · {msg.timestamp}</p>
        )}
        <FeedbackControls canSend={canSendFeedback && !isTyping} sent={feedbackSent} onSend={sendFeedback} />
      </div>
    </div>
  );
}

function FeedbackControls({
  canSend,
  sent,
  onSend,
}: {
  canSend: boolean;
  sent: string | null;
  onSend: (feedbackType: 'wrong' | 'unsafe' | 'missing_evidence' | 'unclear' | 'custom', note?: string) => void;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customNote, setCustomNote] = useState('');

  if (!canSend) return null;
  if (sent) {
    return <div className="ai-feedback-sent">{sent === 'custom' ? 'Feedback sent' : 'Flag sent'}</div>;
  }

  const submitCustom = () => {
    const note = customNote.trim();
    if (!note) return;
    onSend('custom', note);
    setCustomNote('');
    setCustomOpen(false);
  };

  return (
    <div className="ai-feedback-block" aria-label="AI answer feedback">
      <div className="ai-feedback-row">
        <div className="ai-feedback-buttons">
          <span className="fb-tip" data-tip="Wrong">
            <button type="button" onClick={() => onSend('wrong')} aria-label="Flag as wrong"><Flag size={12} /></button>
          </span>
          <span className="fb-tip" data-tip="Missing evidence">
            <button type="button" onClick={() => onSend('missing_evidence')} aria-label="Flag missing evidence"><SearchX size={12} /></button>
          </span>
          <span className="fb-tip" data-tip="Unsafe">
            <button type="button" onClick={() => onSend('unsafe')} aria-label="Flag unsafe advice"><ShieldAlert size={12} /></button>
          </span>
          <span className="fb-tip" data-tip="Unclear">
            <button type="button" onClick={() => onSend('unclear')} aria-label="Flag as unclear"><HelpCircle size={12} /></button>
          </span>
          <span className="fb-tip" data-tip="Custom feedback">
            <button type="button" onClick={() => setCustomOpen(o => !o)} aria-label="Write custom feedback"><MessageSquareText size={12} /></button>
          </span>
        </div>
      </div>
      {customOpen && (
        <div className="ai-custom-feedback">
          <textarea
            rows={1}
            maxLength={280}
            value={customNote}
            placeholder="How should similar boiler answers change?"
            onChange={(e) => setCustomNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitCustom();
              }
              if (e.key === 'Escape') {
                setCustomOpen(false);
                setCustomNote('');
              }
            }}
          />
          <button type="button" className="ai-custom-feedback-cancel" onClick={() => { setCustomOpen(false); setCustomNote(''); }} aria-label="Cancel custom feedback">
            <X size={12} />
          </button>
          <button type="button" className="ai-custom-feedback-send" onClick={submitCustom} disabled={!customNote.trim()} aria-label="Send custom feedback">
            <Send size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

/** Safely converts any LLM output value (string | object | array) to a displayable string. */
function parseNumericValue(value: number | string | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = value.match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function formatBaselineDelta(value: number | string | undefined, baseline: number | string | undefined): { label: string; percent: number } | null {
  const current = parseNumericValue(value);
  const base = parseNumericValue(baseline);
  if (current == null || base == null || base === 0) return null;
  const delta = current - base;
  const percent = (delta / Math.abs(base)) * 100;
  const sign = delta >= 0 ? '+' : '';
  return {
    label: `${sign}${percent.toFixed(1)}% vs baseline`,
    percent,
  };
}

function DiagnosisCard({ data, woCount, ts }: { data: DiagnosisPayload; woCount: number; ts: string }) {
  if (!data) return null;
  const severity = (data.severity || 'warning').toLowerCase();
  const badgeBg = SEVERITY_BADGE[severity] || '#f59e0b';
  const confidence = data.confidence != null ? (data.confidence <= 1 ? data.confidence * 100 : data.confidence) : null;
  const primarySensor = data.deviated_sensors?.[0];
  const deviation = primarySensor ? formatBaselineDelta(primarySensor.value, primarySensor.baseline) : null;

  return (
    <div className="ai-incident-card" style={{ ['--incident-color' as string]: badgeBg }}>
      <div className="ai-incident-rail" />
      <div className="ai-incident-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
            <AlertCircle size={14} color={badgeBg} />
            <span style={{ fontWeight: 800, color: 'var(--tx-primary)', fontSize: 13 }}>Incident card</span>
            <span className="ai-ref-id">WO-{woCount}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ background: badgeBg, color: '#09090b', fontSize: 9, padding: '2px 8px', borderRadius: 3, fontWeight: 800, textTransform: 'uppercase' }}>{severity}</span>
            {confidence != null && <span className="ai-card-meta">Confidence {confidence.toFixed(0)}%</span>}
            <span className="ai-card-meta">Qwen3.5 • {ts}</span>
          </div>
        </div>
        <CheckCircle size={16} color="#4ade80" />
      </div>
      <div style={{ padding: '12px 16px 12px 18px', fontSize: 12, color: 'var(--tx-label)', lineHeight: 1.6 }}>
        <div style={{ fontWeight: 800, marginBottom: 4, color: 'var(--tx-primary)', fontSize: 13 }}>{data.probable_cause || 'Boiler Anomaly'}</div>
        {data.explanation && <p style={{ color: 'var(--tx-secondary)', marginBottom: 8 }}>{normalizeToString(data.explanation)}</p>}
        {deviation && (
          <div className="ai-deviation-strip">
            <div>
              <span>Biggest change from normal</span>
              <strong>{primarySensor?.sensor || primarySensor?.tag || 'Sensor'}</strong>
            </div>
            <div className="ai-deviation-bar"><i style={{ width: `${Math.min(Math.abs(deviation.percent), 100)}%`, background: badgeBg }} /></div>
            <b style={{ color: badgeBg }}>{deviation.label}</b>
          </div>
        )}
        {data.pattern_note && (
          <div style={{ display: 'flex', gap: 8, background: 'var(--pattern-bg)', border: '1px solid var(--pattern-bd)', borderRadius: 8, padding: '8px 10px', marginBottom: 8, fontSize: 11.5, color: 'var(--pattern-tx)', lineHeight: 1.5 }}>
            <span style={{ color: 'var(--pattern-icon)', fontSize: 11, marginTop: 2, flexShrink: 0 }}>↻</span>
            <span><span style={{ fontWeight: 700, color: 'var(--pattern-label)' }}>Seen before:</span> {normalizeToString(data.pattern_note)}</span>
          </div>
        )}
        {data.deviated_sensors && data.deviated_sensors.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {data.deviated_sensors.map((s, i) => {
              const sev = (s.severity || severity).toLowerCase();
              const sbg = SEVERITY_BADGE[sev] || badgeBg;
              return (
                <div key={i} className="ai-sensor-row">
                  <span style={{ background: sbg, color: '#09090b', fontSize: 9, padding: '2px 6px', borderRadius: 3, fontWeight: 800, textTransform: 'uppercase' }}>{sev}</span>
                  <span style={{ color: 'var(--tx-primary)' }}>{s.sensor || s.tag || 'Unknown'}</span>
                  <span style={{ color: 'var(--tx-muted)' }}>•</span>
                  <span style={{ fontWeight: 600, color: 'var(--tx-primary)' }}>{s.value ?? '--'}</span>
                  {s.baseline && <span style={{ color: 'var(--tx-secondary)', fontSize: 10 }}>(normal: {s.baseline})</span>}
                </div>
              );
            })}
          </div>
        )}
        {data.recommended_action != null && (
          <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--bd-inner)', borderRadius: 8, padding: '8px 10px', marginTop: 8 }}>
            <div style={{ fontSize: 9, color: 'var(--tx-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 2 }}>Action</div>
            <p style={{ color: 'var(--tx-primary)', fontSize: 12, whiteSpace: 'pre-line' }}>{normalizeToString(data.recommended_action)}</p>
          </div>
        )}
      </div>
      <div style={{ padding: '8px 16px 8px 18px', background: 'var(--bg-elevated)', borderTop: '1px solid var(--bd-card)', fontSize: 10, color: 'var(--tx-muted)' }}>
        Assigned: Maintenance Team • Synced to CMMS
      </div>
    </div>
  );
}

function ShiftReportCard({ data, ts }: { data: AiResponsePayload; ts: string }) {
  if (!data) return null;
  const alerts = data.alerts || {};
  const totalAlerts = (alerts.CRITICAL || 0) + (alerts.HIGH || 0) + (alerts.WARNING || 0) + (alerts.LOW || 0);
  const eff = data.efficiency || {};
  const effDelta = eff.start != null && eff.end != null ? (eff.end - eff.start) : null;
  const effDeltaStr = effDelta == null ? '--' : (effDelta >= 0 ? '+' : '') + effDelta.toFixed(1) + '%';
  const effColor = effDelta == null ? 'var(--tx-secondary)' : effDelta >= -0.5 ? '#4ade80' : '#f87171';
  const status = (data.overall_status || 'fair').toLowerCase();
  const sColor = status === 'good' ? '#22c55e' : status === 'poor' ? '#ef4444' : '#f59e0b';

  return (
    <div style={{ background: 'var(--bg-ai)', borderRadius: '12px 12px 12px 4px', overflow: 'hidden', border: '1px solid var(--ai-bubble-bd)', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.5)' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--ai-bubble-bd)', background: 'var(--ai-chip-bg)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FileText size={14} color="var(--accent)" />
          <span style={{ fontWeight: 700, color: 'var(--accent-text)', fontSize: 13 }}>End-of-Shift Report</span>
        </div>
        <span style={{ background: sColor, color: '#09090b', fontSize: 9, padding: '2px 9px', borderRadius: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{status}</span>
      </div>
      <div style={{ padding: '12px 16px' }}>
        {data.summary && <p style={{ fontSize: 12, color: 'var(--tx-label)', lineHeight: 1.6, marginBottom: 10 }} dangerouslySetInnerHTML={{ __html: formatRich(String(data.summary)) }} />}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6, marginBottom: 10 }}>
          {[
            ['Uptime', data.uptime_pct != null ? data.uptime_pct.toFixed(1) + '%' : '--', '#4ade80'],
            ['Anomalies', data.anomaly_events != null ? String(data.anomaly_events) : '--', '#fbbf24'],
            ['Alerts', String(totalAlerts), totalAlerts > 0 ? '#f87171' : '#4ade80'],
            ['Eff. Δ', effDeltaStr, effColor],
          ].map(([label, value, color]) => (
            <div key={label} style={{ background: 'var(--ai-chip-bg)', border: '1px solid var(--ai-bubble-bd)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
              <div className="digit" style={{ fontSize: 15, fontWeight: 700, color }}>{value}</div>
              <div style={{ fontSize: 9, color: 'var(--tx-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>
        {data.highlights && data.highlights.length > 0 && (
          <>
            <div style={{ fontSize: 9, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, marginBottom: 3 }}>Shift Highlights</div>
            <div style={{ marginBottom: 10 }}>
              {data.highlights.map((h, i) => <div key={i} style={{ display: 'flex', gap: 7, fontSize: 11.5, color: 'var(--tx-label)', lineHeight: 1.5, padding: '2px 0' }}><span style={{ color: 'var(--accent)', flexShrink: 0 }}>◆</span><span dangerouslySetInnerHTML={{ __html: formatRich(String(h)) }} /></div>)}
            </div>
          </>
        )}
        {data.follow_ups && data.follow_ups.length > 0 && (
          <div style={{ background: 'var(--ai-think-bg)', border: '1px solid var(--ai-bubble-bd)', borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ fontSize: 9, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, marginBottom: 3 }}>Recommended Follow-ups</div>
            {data.follow_ups.map((f, i) => <div key={i} style={{ display: 'flex', gap: 7, fontSize: 11.5, color: 'var(--tx-label)', lineHeight: 1.5, padding: '2px 0' }}><span style={{ color: 'var(--accent)', flexShrink: 0 }}>→</span><span dangerouslySetInnerHTML={{ __html: formatRich(String(f)) }} /></div>)}
          </div>
        )}
      </div>
      <div style={{ padding: '7px 16px', background: 'var(--ai-chip-bg)', borderTop: '1px solid var(--ai-bubble-bd)', fontSize: 10, color: 'var(--tx-muted)' }}>
        {data.shift_label ? `${data.shift_label} · ${data.shift_duration || ''} elapsed` : `Shift window: ${data.shift_duration || '--'}`} • Generated by Nexus AI • {ts}
      </div>
    </div>
  );
}

function WhatIfCard({ data, ts }: { data: AiResponsePayload; ts: string }) {
  if (!data) return null;
  const riskColors: Record<string, string> = { low: '#22c55e', medium: '#f59e0b', high: '#f97316', critical: '#ef4444' };
  const risk = (data.risk_level || 'medium').toLowerCase();
  const rc = riskColors[risk] || '#f59e0b';

  return (
    <div style={{ background: 'var(--bg-ai)', borderRadius: '12px 12px 12px 4px', overflow: 'hidden', border: '1px solid var(--ai-bubble-bd)', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.5)' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--ai-bubble-bd)', background: 'var(--ai-chip-bg)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FlaskConical size={14} color="var(--accent)" />
          <span style={{ fontWeight: 700, color: 'var(--accent-text)', fontSize: 13 }}>What-If Simulation</span>
        </div>
        <span style={{ background: rc, color: '#09090b', fontSize: 9, padding: '2px 9px', borderRadius: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{risk} risk</span>
      </div>
      <div style={{ padding: '12px 16px' }}>
        {data.scenario && <p style={{ fontSize: 11, color: 'var(--tx-muted)', fontStyle: 'italic', marginBottom: 8 }}>Scenario: <span dangerouslySetInnerHTML={{ __html: formatRich(String(data.scenario)) }} /></p>}
        {data.summary && <p style={{ fontSize: 12, color: 'var(--tx-label)', lineHeight: 1.6, marginBottom: 10 }} dangerouslySetInnerHTML={{ __html: formatRich(String(data.summary)) }} />}
        {data.steps && data.steps.length > 0 && (
          <>
            <div style={{ fontSize: 9, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, marginBottom: 3 }}>Consequence Chain</div>
            <div style={{ marginBottom: 10 }}>
              {data.steps.map((s, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, padding: '5px 0' }}>
                  <div style={{ flexShrink: 0, width: 20, height: 20, borderRadius: '50%', background: 'var(--ai-user-bg)', border: '1px solid var(--accent)', color: 'var(--accent-text)', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>{s.step || i + 1}</div>
                  <div style={{ fontSize: 11.5, lineHeight: 1.5 }}>
                    <span style={{ color: 'var(--accent-text)', fontWeight: 600 }} dangerouslySetInnerHTML={{ __html: formatRich(String(s.event || '')) }} />
                    {s.consequence && <><br /><span style={{ color: 'var(--tx-secondary)' }}>→ <span dangerouslySetInnerHTML={{ __html: formatRich(String(s.consequence)) }} /></span></>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        {data.operator_actions && data.operator_actions.length > 0 && (
          <div style={{ background: 'var(--ai-think-bg)', border: '1px solid var(--ai-bubble-bd)', borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ fontSize: 9, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, marginBottom: 3 }}>Operator Actions</div>
            {data.operator_actions.map((a, i) => <div key={i} style={{ display: 'flex', gap: 7, fontSize: 11.5, color: 'var(--tx-label)', lineHeight: 1.5, padding: '2px 0' }}><span style={{ color: 'var(--accent)', flexShrink: 0 }}>→</span><span dangerouslySetInnerHTML={{ __html: formatRich(String(a)) }} /></div>)}
          </div>
        )}
      </div>
      <div style={{ padding: '7px 16px', background: 'var(--ai-chip-bg)', borderTop: '1px solid var(--ai-bubble-bd)', fontSize: 10, color: 'var(--tx-muted)' }}>
        Simulated from live telemetry • Nexus AI • {ts}
      </div>
    </div>
  );
}

const WHEN_COLORS: Record<string, string> = {
  'now': '#ef4444',
  'this shift': '#f97316',
  'this week': '#f59e0b',
  'next outage': '#3b82f6',
};

function MaintenancePrioritiesCard({ data, ts }: { data: AiResponsePayload; ts: string }) {
  if (!data) return null;
  const priorities = data.priorities || [];

  return (
    <div style={{ background: 'var(--bg-ai)', borderRadius: '12px 12px 12px 4px', overflow: 'hidden', border: '1px solid var(--ai-bubble-bd)', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.5)' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--ai-bubble-bd)', background: 'var(--ai-chip-bg)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Wrench size={14} color="var(--accent)" />
          <span style={{ fontWeight: 700, color: 'var(--accent-text)', fontSize: 13 }}>Maintenance Priorities</span>
        </div>
        {data.window && (
          <span style={{ background: 'var(--ai-user-bg)', color: 'var(--accent-text)', fontSize: 9, padding: '2px 9px', borderRadius: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{data.window}</span>
        )}
      </div>
      <div style={{ padding: '12px 16px' }}>
        {data.summary && <p style={{ fontSize: 12, color: 'var(--tx-label)', lineHeight: 1.6, marginBottom: 10 }}>{data.summary}</p>}

        {priorities.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--tx-secondary)', lineHeight: 1.6 }}>{data.answer}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {priorities.map((p) => {
              const sev = (p.severity || 'warning').toLowerCase();
              const sevColor = SEVERITY_BADGE[sev] || '#f59e0b';
              const whenColor = WHEN_COLORS[(p.when || '').toLowerCase()] || 'var(--accent)';
              return (
                <div key={p.rank} style={{ background: 'var(--ai-chip-bg)', border: '1px solid var(--ai-bubble-bd)', borderLeft: `3px solid ${sevColor}`, borderRadius: 8, padding: '9px 11px' }}>
                  {/* header row: rank + when + discipline */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                    <span style={{ flexShrink: 0, minWidth: 18, height: 18, borderRadius: '50%', background: sevColor, color: '#09090b', fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' }}>{p.rank}</span>
                    <span style={{ background: whenColor, color: '#09090b', fontSize: 8.5, padding: '2px 7px', borderRadius: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{p.when}</span>
                    <span style={{ fontSize: 10, color: 'var(--tx-muted)', marginLeft: 'auto' }}>{p.discipline}</span>
                  </div>

                  {/* task headline */}
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--tx-primary)', lineHeight: 1.4, marginBottom: 4 }}>{p.task}</div>

                  {/* why / do */}
                  {p.impact && (
                    <div style={{ fontSize: 11, color: 'var(--tx-secondary)', lineHeight: 1.5, marginBottom: 2 }}>
                      <span style={{ color: sevColor, fontWeight: 700 }}>Why: </span>{p.impact}
                    </div>
                  )}
                  {p.detail && (
                    <div style={{ fontSize: 11, color: 'var(--tx-secondary)', lineHeight: 1.5, marginBottom: p.evidence && p.evidence.length ? 5 : 0 }}>
                      <span style={{ color: 'var(--accent-text)', fontWeight: 700 }}>Do: </span>{p.detail}
                    </div>
                  )}

                  {/* evidence chips */}
                  {p.evidence && p.evidence.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {p.evidence.map((e, i) => (
                        <span key={i} style={{ fontSize: 9.5, color: 'var(--tx-muted)', background: 'var(--ai-think-bg)', border: '1px solid var(--ai-bubble-bd)', borderRadius: 5, padding: '2px 6px', lineHeight: 1.4 }}>{e}</span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {data.note && (
          <p style={{ fontSize: 10, color: 'var(--tx-muted)', fontStyle: 'italic', marginTop: 10 }}>{data.note}</p>
        )}
      </div>
      <div style={{ padding: '7px 16px', background: 'var(--ai-chip-bg)', borderTop: '1px solid var(--ai-bubble-bd)', fontSize: 10, color: 'var(--tx-muted)' }}>
        {data.samples_7d != null && `${data.samples_7d} samples (7d)`}
        {data.samples_30d != null && ` • ${data.samples_30d} (30d)`} • Nexus AI • {ts}
      </div>
    </div>
  );
}
