import './styles.css';
import { StrictMode, createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import { Monogram } from './Monogram';
import { ToastHost, useLoad, useToast } from './ui';
import { Landing } from './pages/Landing';
import { Overview } from './pages/Overview';
import { Transactions } from './pages/Requests';
import { Investigation } from './pages/Investigation';
import { Payees } from './pages/Vendors';
import { Agents } from './pages/Agents';
import { Policy } from './pages/Policy';
import { SecurityTesting } from './pages/Challenge';
import { Settings } from './pages/Settings';
import { PayPalReturn } from './pages/PayPalReturn';

export type Me = { user: { id: string; name: string; role: string } | null; workspace?: { id: string; name: string; kind: string }; members?: { id: string; name: string; role: string }[] };
const MeCtx = createContext<{ me: Me; refresh: () => Promise<void> }>({ me: { user: null }, refresh: async () => {} });
export const useMe = () => useContext(MeCtx);
export const ROLE_WORD: Record<string, string> = { OWNER: 'Owner', FINANCE_ADMIN: 'Finance admin', REVIEWER: 'Reviewer', AUDITOR: 'Auditor' };
export const can = (role: string | undefined, roles: string[]) => Boolean(role && roles.includes(role));

function Splash() {
  return <div className="splash" aria-hidden="true"><div className="splash-inner"><Monogram size={88} animate /><div className="splash-word">PayeeProof</div></div></div>;
}

function Root() {
  const [me, setMe] = useState<Me | null>(null);
  const [splash, setSplash] = useState(() => { try { return !sessionStorage.getItem('pp-splash'); } catch { return true; } });
  const refresh = async () => { setMe(await api.get<Me>('/api/me').catch(() => ({ user: null }))); };
  useEffect(() => {
    refresh();
    if (splash) { const t = setTimeout(() => { setSplash(false); try { sessionStorage.setItem('pp-splash', '1'); } catch { /* storage may be unavailable */ } }, 1500); return () => clearTimeout(t); }
  }, []);
  if (!me || splash) return <Splash />;
  return (
    <MeCtx.Provider value={{ me, refresh }}>
      <Routes>
        <Route path="/" element={me.user ? <Navigate to="/app" replace /> : <Landing />} />
        <Route path="/welcome" element={<Landing />} />
        <Route path="/paypal/return" element={<Guard><Shell><PayPalReturn /></Shell></Guard>} />
        <Route path="/app/*" element={<Guard><Shell><AppRoutes /></Shell></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </MeCtx.Provider>
  );
}
const Guard = ({ children }: { children: ReactNode }) => (useMe().me.user ? <>{children}</> : <Navigate to="/" replace />);
const AppRoutes = () => (
  <Routes>
    <Route index element={<Overview />} />
    <Route path="transactions" element={<Transactions />} />
    <Route path="transactions/:id" element={<Investigation />} />
    <Route path="payees" element={<Payees />} />
    <Route path="agents" element={<Agents />} />
    <Route path="policies" element={<Policy />} />
    <Route path="security-testing" element={<SecurityTesting />} />
    <Route path="settings" element={<Settings />} />
    {/* Earlier paths, kept so old links still land somewhere sensible. */}
    <Route path="requests" element={<Navigate to="/app/transactions" replace />} />
    <Route path="requests/:id" element={<LegacyRequest />} />
    <Route path="vendors" element={<Navigate to="/app/payees" replace />} />
    <Route path="policy" element={<Navigate to="/app/policies" replace />} />
    <Route path="challenge" element={<Navigate to="/app/security-testing" replace />} />
    <Route path="audit" element={<Navigate to="/app/settings?tab=audit" replace />} />
    <Route path="*" element={<Navigate to="/app" replace />} />
  </Routes>
);
function LegacyRequest() { const id = useLocation().pathname.split('/').pop(); return <Navigate to={`/app/transactions/${id}`} replace />; }

const I = (d: string) => <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const NAV: [string, string, ReactNode][] = [
  ['/app', 'Overview', I('M3 10.5L10 4l7 6.5M5 9v7h10V9')],
  ['/app/transactions', 'Transactions', I('M4 6h12M4 10h12M4 14h8')],
  ['/app/payees', 'Payees', I('M10 3l6 2.5v4c0 3.6-2.6 6.3-6 7.5-3.4-1.2-6-3.9-6-7.5v-4L10 3zM7.3 10l1.9 1.9L13 8')],
  ['/app/agents', 'AI Agents', I('M5 7.5h10a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 15 15.5H5A1.5 1.5 0 0 1 3.5 14V9A1.5 1.5 0 0 1 5 7.5zM10 4.5v3M7.5 11.5h.01M12.5 11.5h.01')],
  ['/app/policies', 'Policies', I('M6 3.5h6l3 3v10H6zM12 3.5v3h3M8.5 10h4M8.5 13h4')],
  ['/app/security-testing', 'Security Testing', I('M8 3.5h4M9 3.5v4.5l-4.5 7.2A1 1 0 0 0 5.4 16.7h9.2a1 1 0 0 0 .9-1.5L11 8V3.5M6.7 12h6.6')],
  ['/app/settings', 'Settings', I('M10 7.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6zM10 2.8v2M10 15.2v2M17.2 10h-2M4.8 10h-2M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4M15.1 15.1l-1.4-1.4M6.3 6.3L4.9 4.9')],
];

function Shell({ children }: { children: ReactNode }) {
  const { me, refresh } = useMe();
  const nav = useNavigate();
  const toast = useToast();
  const loc = useLocation();
  const dash = useLoad<any>('/api/dashboard', [loc.pathname]);
  useEffect(() => { window.scrollTo(0, 0); }, [loc.pathname]);
  const switchUser = async (userId: string) => {
    await api.post('/api/demo/switch-user', { userId });
    await refresh();
    const m = me.members?.find((x) => x.id === userId);
    toast(`You are now ${m?.name}, ${ROLE_WORD[m?.role ?? '']?.toLowerCase()}`);
  };
  const signOut = async () => { await api.post('/api/auth/logout'); await refresh(); nav('/'); };
  const waiting = dash.data ? dash.data.counts.UNDER_REVIEW + dash.data.counts.HELD : 0;
  return (
    <div className="shell">
      <a href="#main" className="sr-only">Skip to content</a>
      <aside className="side">
        <NavLink to="/app" className="brand" aria-label="PayeeProof overview"><Monogram size={30} />PayeeProof</NavLink>
        <nav className="nav" aria-label="Main">{NAV.map(([to, label, icon]) => <NavLink key={to} to={to} end={to === '/app'}>{icon}{label}{to === '/app/transactions' && waiting > 0 && <span className="count" title="Held or under review">{waiting}</span>}</NavLink>)}</nav>
        <div className="side-foot">
          <div className="who">
            {me.workspace?.kind === 'DEMO' && me.members ? (
              <label><span className="sr-only">Acting as</span>
                <select value={me.user!.id} onChange={(e) => switchUser(e.target.value)} title="Switch person to test roles">
                  {me.members.map((m) => <option key={m.id} value={m.id}>{m.name}, {ROLE_WORD[m.role]}</option>)}
                </select>
              </label>
            ) : <span className="small"><strong>{me.user?.name}</strong> <span className="muted">{ROLE_WORD[me.user?.role ?? '']}</span></span>}
          </div>
          <span className="tag" style={{ width: 'fit-content' }}>PayPal sandbox only</span>
          <button className="btn btn-sm btn-quiet" onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <div className="content">
        <main id="main">{children}</main>
        <footer className="footer"><div className="footer-inner">
          <span>{me.workspace?.name}{me.workspace?.kind === 'DEMO' ? ', a demo workspace with fictional vendors' : ''}</span>
          <span>PayeeProof is an independent hackathon project, not affiliated with or endorsed by PayPal. Payments run in the PayPal sandbox only.</span>
        </div></footer>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><ToastHost><Root /></ToastHost></BrowserRouter></StrictMode>);
