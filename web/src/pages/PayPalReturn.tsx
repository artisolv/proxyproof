import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';

/** The buyer's browser lands here after approving. Arriving proves nothing; the server captures and asks PayPal. */
export function PayPalReturn() {
  const [params] = useSearchParams();
  const id = params.get('request');
  const [state, setState] = useState<{ status?: string; error?: string }>({});
  useEffect(() => { if (id) api.post(`/api/payment-requests/${id}/capture`).then((r) => setState(r)).catch((e) => setState({ error: e.message })); }, [id]);
  return <div className="panel" style={{ maxWidth: 640 }}>
    <h1 className="h2">Completing the payment</h1>
    <p className="lead" style={{ marginTop: 10 }}>{state.error ? state.error : !state.status ? 'Checking the policy again and asking PayPal to capture…' : state.status === 'COMPLETED' ? 'PayPal confirmed the payment.' : `PayPal reports ${state.status.toLowerCase().replace('_', ' ')}.`}</p>
    {id && <Link className="btn btn-primary" style={{ marginTop: 18 }} to={`/app/transactions/${id}`}>Open the investigation</Link>}
  </div>;
}
