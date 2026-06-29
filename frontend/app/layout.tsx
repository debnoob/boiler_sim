import type { Metadata } from 'next';
import './globals.css';
import { MqttProvider } from '@/components/MqttProvider';
import { AppShell } from '@/components/AppShell';

export const metadata: Metadata = {
  title: 'NEXUS OS • Boiler Intelligence',
  description: 'Real-time industrial boiler monitoring with AI-powered anomaly detection',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <MqttProvider>
          <AppShell>{children}</AppShell>
        </MqttProvider>
      </body>
    </html>
  );
}
