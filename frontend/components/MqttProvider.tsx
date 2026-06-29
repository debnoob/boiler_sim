'use client';

import { useMqtt } from '@/hooks/useMqtt';
import { useEffect } from 'react';
import { useNexusStore } from '@/lib/store';

interface Props {
  children: (publish: (topic: string, payload: object) => void) => React.ReactNode;
}

export function MqttProvider({ children }: Props) {
  const { publish } = useMqtt();

  // Restore theme on mount
  useEffect(() => {
    const saved = localStorage.getItem('nexus-theme');
    if (saved === 'light') {
      document.body.classList.add('light');
      useNexusStore.setState({ isLight: true });
    }
  }, []);

  return <>{children(publish)}</>;
}
