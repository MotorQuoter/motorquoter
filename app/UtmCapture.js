'use client';

// batch 229 — on any page load whose URL carries utm_source / utm_medium / utm_campaign, keep them in sessionStorage
// (first touch wins) so they survive a reload, the ?free_error= bounce and /salvage ↔ /salvage/free-report.
// Renders nothing. The rules live in lib/utm.mjs.
import { useEffect } from 'react';
import { captureUtm } from '@/lib/utm.mjs';

export default function UtmCapture() {
  useEffect(() => {
    let storage = null;
    try { storage = window.sessionStorage; } catch { /* blocked — no attribution */ }
    captureUtm(window.location.search, storage);
  }, []);
  return null;
}
