import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';

/** The buyer's browser lands here after approving on PayPal. Arriving proves nothing: the server re-checks authority, captures, and asks PayPal. */
export function PayPalReturn() {
  const [params] = useSearchParams();
  const id = params.get('tx');
  const [state, setState] = useState<{ status?: string; error?: string }>({});
  useEffect(() => { if (id) api.post(`/api/transactions/${id}/capture`).then((r) => setState(r)).catch((e) => setState({ error: e.message })); }, [id]);
  return (
    <div className="landing"><main style={{ paddingTop: 64, maxWidth: 640 }}>
      <h1 style={{ fontSize: 26, fontWeight: 800 }}>Completing the payment</h1>
      <p style={{ marginTop: 10, color: 'var(--ink-2)' }}>{state.error ? state.error : !state.status ? 'Checking the agent’s authority again, then asking PayPal to capture…' : state.status === 'COMPLETED' ? 'PayPal confirmed the payment.' : `PayPal reports: ${state.status.toLowerCase().replace(/_/g, ' ')}.`}</p>
      <Link className="btn btn-primary" style={{ marginTop: 20 }} to="/app">Back to the scenario lab</Link>
    </main></div>
  );
}
