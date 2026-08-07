'use client';

// Trustpilot Review Collector widget (free plan). IDs are public — they ship in
// client-side HTML on every visitor's browser, so they live in code, not env.
// Placed on report-delivery pages so buyers are invited to review right after
// they've received their report. Re-inits on client-side navigation via
// window.Trustpilot.loadFromElement.

import { useEffect, useRef } from 'react';

const TP_SRC = 'https://widget.trustpilot.com/bootstrap/v5/tp.widget.bootstrap.min.js';

export default function TrustpilotReviewCollector({ heading = 'Was your report useful?' }) {
  const ref = useRef(null);

  useEffect(() => {
    function render() {
      if (typeof window !== 'undefined' && window.Trustpilot && ref.current) {
        window.Trustpilot.loadFromElement(ref.current, true);
      }
    }

    // Already loaded (e.g. arrived via client-side nav) → render now.
    if (typeof window !== 'undefined' && window.Trustpilot) {
      render();
      return;
    }

    // Otherwise inject the bootstrap once, then render on load.
    let script = document.querySelector(`script[src="${TP_SRC}"]`);
    let injected = false;
    if (!script) {
      script = document.createElement('script');
      script.src = TP_SRC;
      script.async = true;
      document.head.appendChild(script);
      injected = true;
    }
    script.addEventListener('load', render);
    return () => {
      if (script) script.removeEventListener('load', render);
      // leave the (cached) script in the DOM even if we injected it
      void injected;
    };
  }, []);

  return (
    <div style={{ margin: '20px 20px 4px', textAlign: 'center' }}>
      {heading ? (
        <div
          style={{
            fontFamily: "'Barlow Condensed', sans-serif",
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--text-dim)',
            marginBottom: 8,
          }}
        >
          {heading}
        </div>
      ) : null}

      {/* TrustBox widget - Review Collector */}
      <div
        ref={ref}
        className="trustpilot-widget"
        data-locale="en-GB"
        data-template-id="56278e9abfbbba0bdcd568bc"
        data-businessunit-id="6a7599f3ec5d5ad0ff649650"
        data-style-height="52px"
        data-style-width="100%"
        data-token="028a2a69-ef7e-4407-8262-ccb7d9562fdd"
      >
        <a
          href="https://www.trustpilot.com/review/motorquoter.app"
          target="_blank"
          rel="noopener noreferrer"
        >
          Trustpilot
        </a>
      </div>
      {/* End TrustBox widget */}
    </div>
  );
}
