'use client';

import { AiChat } from '@/components/AiChat';
import { useNexusStore } from '@/lib/store';

export default function AiAdvisorPage() {
  const { aiStatus, anomalyScore, chatMessages } = useNexusStore();
  const diagnosisCount = chatMessages.filter(m => m.type === 'diagnosis').length;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16, alignItems: 'start', width: '100%' }}>
      {/* Chat */}
      <div style={{ minWidth: 0 }}>
        <AiChat />
      </div>

      {/* Evidence sidebar */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <div className="card">
          <div className="ops-panel-header">
            <div>
              <h2>Evidence Package</h2>
              <p>What the local analyst uses to reason</p>
            </div>
          </div>
          <div className="card-content">
            <div className="kpi-row">
              <div><span>Model Path</span><strong>Ollama</strong></div>
              <div><span>AI State</span><strong>{aiStatus.toUpperCase()}</strong></div>
              <div><span>Detector</span><strong>Iso. Forest</strong></div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="ops-panel-header">
            <div>
              <h2>Session Stats</h2>
              <p>Current monitoring session</p>
            </div>
          </div>
          <div className="card-content">
            <div className="kpi-row">
              <div><span>Anomaly Score</span><strong>{anomalyScore}%</strong></div>
              <div><span>Diagnoses</span><strong>{diagnosisCount}</strong></div>
            </div>
            <div className="operator-action" style={{ marginTop: 12 }}>
              <span>Guardrail</span>
              <p>The LLM explains confirmed anomaly events only. Mathematical detection stays in the local Isolation Forest detector.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
