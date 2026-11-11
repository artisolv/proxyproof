import './styles.css';
import { StrictMode, createContext, useContext, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { Landing } from './pages/Landing';
import { Dashboard } from './pages/Dashboard';
import { PayPalReturn } from './pages/PayPalReturn';
import { Explorer } from './pages/Explorer';

export type Me = { user: { name: string; workspaceId: string } | null };
const MeCtx = createContext<{ me: Me; refresh: () => Promise<void> }>({ me: { user: null }, refresh: async () => {} });
export const useMe = () => useContext(MeCtx);

/** Two experiences: the landing page (with its architecture explorer) and the dashboard. */
function Root() {
  const [me, setMe] = useState<Me | null>(null);
  const refresh = async () => setMe(await api.get<Me>('/api/me').catch(() => ({ user: null })));
  useEffect(() => { refresh(); }, []);
  if (!me) return null;
  return (
    <MeCtx.Provider value={{ me, refresh }}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app" element={me.user ? <Dashboard /> : <Navigate to="/" replace />} />
        <Route path="/architecture" element={<Explorer />} />
        <Route path="/paypal/return" element={<PayPalReturn />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </MeCtx.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><Root /></BrowserRouter></StrictMode>);
