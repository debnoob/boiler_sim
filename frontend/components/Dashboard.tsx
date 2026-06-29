'use client';

import { MqttProvider } from './MqttProvider';
import { Header } from './Header';
import { MqttStream } from './MqttStream';
import { PredictivePanel } from './PredictivePanel';
import { AlertTimeline } from './AlertTimeline';
import { AiChat } from './AiChat';
import { LiveTags } from './LiveTags';

export function Dashboard() {
  return (
    <MqttProvider>
      {(publish) => (
        <div className="max-w-[1600px] mx-auto p-6">
          <Header />
          <MqttStream />

          {/* Main Grid: 2/3 left, 1/3 right */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">

            {/* LEFT 2/3 */}
            <div className="col-span-1 xl:col-span-2 space-y-6">
              <PredictivePanel />
              <AlertTimeline />
            </div>

            {/* RIGHT 1/3 */}
            <div className="space-y-6">
              <AiChat publish={publish} />
              <LiveTags />
            </div>

          </div>
        </div>
      )}
    </MqttProvider>
  );
}
