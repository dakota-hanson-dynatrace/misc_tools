import React, { createContext, useContext } from 'react';
import { useDocumentStorage } from '../hooks/useDocumentStorage';

type IpamContextType = ReturnType<typeof useDocumentStorage>;

const IpamContext = createContext<IpamContextType | null>(null);

export function IpamProvider({ children }: { children: React.ReactNode }) {
  const storage = useDocumentStorage();
  return <IpamContext.Provider value={storage}>{children}</IpamContext.Provider>;
}

export function useIpam(): IpamContextType {
  const ctx = useContext(IpamContext);
  if (!ctx) throw new Error('useIpam must be used within IpamProvider');
  return ctx;
}
