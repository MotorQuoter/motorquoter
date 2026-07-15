'use client';

import { useState } from 'react';
import { FREE_REPORT_STRINGS } from '@/config/freeReport.mjs';

export default function FreeReportPage() {
  const [email, setEmail] = useState('');
  const [optIn, setOptIn] = useState(false); // ruling: UNTICKED by default
  const [status, setStatus] = useState('idle'); // idle | sending | done | error
  const [message, setMessage] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (status === 'sending') return;
    setStatus('sending');
    setMessage('');
    try {
      const res = await fetch('/api/salvage/free-report/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, marketingOptIn: optIn }),
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
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 10 }}>Your first report, free</h1>
        <p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--text-dim, #a8a29e)', marginBottom: 20 }}>
          {FREE_REPORT_STRINGS.requestForm}
        </p>

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
