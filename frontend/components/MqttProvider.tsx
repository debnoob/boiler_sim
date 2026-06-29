'use client';

import { useMqtt } from '@/hooks/useMqtt';
import { useEffect } from 'react';
import { useNexusStore } from '@/lib/store';
import { PublishProvider } from '@/lib/publishContext';

export function MqttProvider({ children }: { children: React.ReactNode }) {
  const { publish } = useMqtt();

  useEffect(() => {
    const saved = localStorage.getItem('nexus-theme');
    if (saved === 'light') {
      document.body.classList.add('light');
      useNexusStore.setState({ isLight: true });
    }
  }, []);

  return <PublishProvider value={publish}>{children}</PublishProvider>;
}
