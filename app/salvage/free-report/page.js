'use client';

import { useState, useSyncExternalStore } from 'react';
import { FREE_REPORT_STRINGS, freeErrorLine } from '@/config/freeReport.mjs';
import { PRICING } from '@/config/pricing';
import { readStoredUtm } from '@/lib/utm.mjs';
import { FREE_REPORT_EXAMPLE as EX, exampleRows, truncateCheck } from '@/config/freeReportExample.mjs';

const noSubscribe = () => () => {}; // the query string does not change while the page is open

// batch 231 — what the report is: one real stored report's figures (config/freeReportExample.mjs). Informs only —
// no verdict, no margin judgement; the ceiling is the report's own break-even figure.
const exRowSt = { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' };
const exValSt = { fontWeight: 700, whiteSpace: 'nowrap', textAlign: 'right' };
function ExampleReport() {
  const { rows, more } = exampleRows();
  return (
    <div data-example-report style={{ padding: 14, borderRadius: 12, marginBottom: 20, fontSize: 13, lineHeight: 1.45,
      background: 'var(--bg2, #1a1a1d)', border: '1.5px solid var(--border, #2a2a2e)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
        color: 'var(--orange, #f05a1a)', marginBottom: 6 }}>{EX.label}</div>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>
        {EX.vehicle} <span style={{ fontWeight: 400, color: 'var(--text-dim, #a8a29e)' }}>· {EX.damage}</span>
      </div>
      <div data-example-note style={{ fontSize: 11, color: 'var(--text-dim, #a8a29e)', marginBottom: 8 }}>{EX.note}</div>
      {rows.map((r) => (
        <div key={r.name} style={exRowSt}>
          <span style={{ color: 'var(--text-dim, #a8a29e)', minWidth: 0 }}>{r.name}</span><span style={exValSt}>{r.figure}</span>
        </div>
      ))}
      {more > 0 && <div style={{ color: 'var(--text-dim, #a8a29e)', padding: '3px 0' }}>+ {more} more lines</div>}
      <div style={{ ...exRowSt, borderTop: '1px solid var(--border, #2a2a2e)', marginTop: 4, paddingTop: 6 }}>
        <span style={{ fontWeight: 700 }}>Repair total</span><span style={exValSt}>{EX.repairTotal}</span>
      </div>
      <div style={{ borderTop: '1px solid var(--border, #2a2a2e)', marginTop: 6, paddingTop: 6 }}>
        <div style={exRowSt}><span style={{ color: 'var(--text-dim, #a8a29e)' }}>Worth repaired:</span><span style={exValSt}>{EX.worthRepaired}</span></div>
        <div style={exRowSt}><span style={{ color: 'var(--text-dim, #a8a29e)' }}>Copart fees at {EX.feesHammer}:</span><span style={exValSt}>{EX.fees}</span></div>
        <div style={exRowSt}><span style={{ color: 'var(--text-dim, #a8a29e)' }}>Most you can bid and break even:</span><span style={exValSt}>{EX.breakEven}</span></div>
      </div>
      <div style={{ borderTop: '1px solid var(--border, #2a2a2e)', marginTop: 6, paddingTop: 6 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>What to check before you bid:</div>
        <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-dim, #a8a29e)' }}>
          {EX.checklist.map((c) => <li key={c} style={{ marginBottom: 3 }}>{truncateCheck(c)}</li>)}
        </ul>
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-dim, #a8a29e)' }}>{EX.footer}</div>
    </div>
  );
}

export default function FreeReportPage() {
  const [email, setEmail] = useState('');
  const [optIn, setOptIn] = useState(false); // ruling: UNTICKED by default
  const [status, setStatus] = useState('idle'); // idle | sending | done | error
  const [message, setMessage] = useState('');
  // batch 225: why a confirm link failed (?free_error=<reason>). Read from the URL on the client; null on the server.
  const freeErrorReason = useSyncExternalStore(noSubscribe, () => new URLSearchParams(window.location.search).get('free_error'), () => null);
  const freeError = freeErrorLine(freeErrorReason, PRICING.salvageAssessment.price);

  const submit = async (e) => {
    e.preventDefault();
    if (status === 'sending') return;
    setStatus('sending');
    setMessage('');
    // batch 229 — where this visitor came from (captured on arrival by app/UtmCapture.js); all null when absent.
    let storage = null;
    try { storage = window.sessionStorage; } catch { /* blocked — no attribution */ }
    const utm = readStoredUtm(storage);
    try {
      const res = await fetch('/api/salvage/free-report/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, marketingOptIn: optIn, ...utm }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus('done');
        setMessage(data.message || FREE_REPORT_STRINGS.neutral);
      } else {
        setStatus('error');
        setMessage(data.error || 'Something went wrong — please try again.');
      }
    } catch {
      setStatus('error');
      setMessage('Something went wrong — please try again.');
    }
  };

  return (
    <main style={{ minHeight: '100vh', background: 'var(--bg, #0e0e10)', color: 'var(--text, #f0ebe6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 480 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 10 }}>See what you&apos;re bidding on. Your first report&apos;s free.</h1>
        <p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--text-dim, #a8a29e)', marginBottom: 20 }}>
          {FREE_REPORT_STRINGS.requestForm}
        </p>

        <ExampleReport />

        {freeError && status !== 'done' && (
          <div style={{ padding: '12px 14px', borderRadius: 10, marginBottom: 16, fontSize: 14, lineHeight: 1.5,
            background: 'var(--bg2, #1a1a1d)', border: '1.5px solid #f87171' }}>
            {freeError}
          </div>
        )}

        {status === 'done' ? (
          <div style={{ padding: 16, borderRadius: 12, background: 'var(--bg2, #1a1a1d)',
            border: '1.5px solid var(--border, #2a2a2e)', fontSize: 14, lineHeight: 1.5 }}>
            {message}
          </div>
        ) : (
          <form onSubmit={submit}>
            <input
              type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com" autoComplete="email"
              style={{ width: '100%', padding: '12px 14px', fontSize: 15, borderRadius: 10,
                background: 'var(--bg2, #1a1a1d)', color: 'var(--text, #f0ebe6)',
                border: '1.5px solid var(--border, #2a2a2e)', marginBottom: 14 }}
            />
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13,
              lineHeight: 1.45, color: 'var(--text-dim, #a8a29e)', marginBottom: 18, cursor: 'pointer' }}>
              <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)}
                style={{ marginTop: 2, flexShrink: 0 }} />
              <span>{FREE_REPORT_STRINGS.consent}</span>
            </label>
            {status === 'error' && (
              <div style={{ fontSize: 13, color: '#f87171', marginBottom: 14 }}>{message}</div>
            )}
            <button type="submit" disabled={status === 'sending'}
              style={{ width: '100%', padding: '13px 16px', fontSize: 15, fontWeight: 700,
                borderRadius: 10, border: 'none', cursor: 'pointer',
                background: 'var(--orange, #f05a1a)', color: '#fff', opacity: status === 'sending' ? 0.6 : 1 }}>
              {status === 'sending' ? 'Sending…' : 'Send my verification link'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
