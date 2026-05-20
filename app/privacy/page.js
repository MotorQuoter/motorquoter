export default function PrivacyPage() {
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&family=Barlow:wght@400;500;600&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          --bg: #1e1a17;
          --bg2: #2a2420;
          --bg3: #332e29;
          --orange: #f05a1a;
          --orange-light: #ff6b2b;
          --orange-dim: rgba(240,90,26,0.15);
          --text: #f0ebe6;
          --text-dim: #9a8f87;
          --border: rgba(240,90,26,0.25);
          --border-dim: rgba(255,255,255,0.08);
        }

        body { background: var(--bg); color: var(--text); font-family: 'Barlow', sans-serif; min-height: 100vh; }

        .app { max-width: 480px; margin: 0 auto; padding: 0 0 60px; }

        .header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border-dim); }
        .logo { display: flex; align-items: center; gap: 10px; text-decoration: none; }
        .logo-text { font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 20px; letter-spacing: 0.05em; color: var(--text); }

        .hero { padding: 32px 20px 24px; }
        .hero-eyebrow { font-family: 'Barlow Condensed', sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 0.2em; color: var(--orange); margin-bottom: 10px; text-transform: uppercase; }
        .hero-title { font-family: 'Barlow Condensed', sans-serif; font-weight: 900; font-size: 48px; line-height: 0.96; letter-spacing: -0.01em; text-transform: uppercase; color: var(--text); }

        .content { padding: 0 20px; display: flex; flex-direction: column; gap: 0; }

        .section { border-bottom: 1px solid var(--border-dim); padding: 20px 0; }
        .section:last-child { border-bottom: none; }

        .section-heading { font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 17px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--orange); margin-bottom: 10px; }

        .section-body { font-size: 14px; color: var(--text-dim); line-height: 1.65; }

        .footer-note { text-align: center; padding: 28px 20px 0; font-size: 12px; color: var(--text-dim); line-height: 1.6; }
        .footer-note a { color: var(--orange); text-decoration: none; }
      `}</style>

      <div className="app">
        <header className="header">
          <a href="/" className="logo">
            <svg viewBox="0 0 36 36" width="36" height="36" xmlns="http://www.w3.org/2000/svg">
              <circle cx="18" cy="18" r="16" fill="none" stroke="#e8500a" strokeWidth="2.5"/>
              <circle cx="18" cy="18" r="11" fill="none" stroke="#e8500a" strokeWidth="1.5"/>
              <line x1="18" y1="18" x2="18"   y2="7"    stroke="#e8500a" strokeWidth="1.5"/>
              <line x1="18" y1="18" x2="28.5" y2="14.6" stroke="#e8500a" strokeWidth="1.5"/>
              <line x1="18" y1="18" x2="24.5" y2="26.9" stroke="#e8500a" strokeWidth="1.5"/>
              <line x1="18" y1="18" x2="11.5" y2="26.9" stroke="#e8500a" strokeWidth="1.5"/>
              <line x1="18" y1="18" x2="7.5"  y2="14.6" stroke="#e8500a" strokeWidth="1.5"/>
              <circle cx="18" cy="18" r="2.5" fill="#e8500a"/>
            </svg>
            <span className="logo-text">MOTORQUOTER</span>
          </a>
        </header>

        <div className="hero">
          <p className="hero-eyebrow">Legal</p>
          <h1 className="hero-title">Privacy Policy</h1>
        </div>

        <div className="content">

          <div className="section">
            <div className="section-heading">Who We Are</div>
            <p className="section-body">MotorQuoter Ltd, 180 Joanmount Gardens, Belfast BT14 6PA, registered in Northern Ireland. ICO Registration Number: ZB719601. Contact: info@motorquoter.app</p>
          </div>

          <div className="section">
            <div className="section-heading">What Data We Collect</div>
            <p className="section-body">We collect vehicle registration marks (VRMs) entered by users in order to perform vehicle checks. If you make a payment, your transaction is processed by Stripe — we do not store or handle card details. We may collect an email address if you contact us directly.</p>
          </div>

          <div className="section">
            <div className="section-heading">Why We Collect It</div>
            <p className="section-body">VRMs are collected solely to perform the vehicle checks you have requested and to return the results to you. We do not use your data for marketing, profiling, or any purpose beyond fulfilling your lookup request.</p>
          </div>

          <div className="section">
            <div className="section-heading">Third Party Data Processors</div>
            <p className="section-body">We use the following third party processors to deliver our service:</p>
            <p className="section-body" style={{marginTop: 10}}>
              <strong style={{color: 'var(--text)'}}>Stripe</strong> — payment processing. Card data is handled entirely by Stripe and is never stored by MotorQuoter.<br /><br />
              <strong style={{color: 'var(--text)'}}>Supabase</strong> — temporary caching of lookup results (see Data Retention below).<br /><br />
              <strong style={{color: 'var(--text)'}}>Experian / One Auto API</strong> — vehicle data including history, finance, and write-off records.<br /><br />
              <strong style={{color: 'var(--text)'}}>Anthropic</strong> — AI-powered damage assessment for the Salvage Assessment Tool.
            </p>
          </div>

          <div className="section">
            <div className="section-heading">Data Retention</div>
            <p className="section-body">VRM lookup results are cached for 48 hours to avoid duplicate API calls, then automatically deleted. We do not retain a record of which user performed which lookup beyond this window.</p>
          </div>

          <div className="section">
            <div className="section-heading">We Do Not Sell Your Data</div>
            <p className="section-body">MotorQuoter does not sell, rent, or otherwise transfer personal data to third parties for commercial purposes. Data shared with the processors listed above is strictly for the purpose of delivering the service.</p>
          </div>

          <div className="section">
            <div className="section-heading">Cookies</div>
            <p className="section-body">We use essential cookies only, required for session management and payment processing. We do not use advertising cookies, tracking cookies, or any third party analytics. You can disable cookies in your browser settings, but this may affect your ability to use the service.</p>
          </div>

          <div className="section">
            <div className="section-heading">Your Rights Under UK GDPR</div>
            <p className="section-body">You have the right to access the personal data we hold about you, request rectification of inaccurate data, and request erasure of your data where it is no longer necessary for the purpose for which it was collected. To exercise any of these rights, contact us at info@motorquoter.app.</p>
          </div>

          <div className="section">
            <div className="section-heading">Last Updated</div>
            <p className="section-body">May 2026</p>
          </div>

        </div>

        <p className="footer-note">
          Not affiliated with Copart, CAP or HPI.<br />
          <a href="/terms">Terms &amp; Conditions</a> &nbsp;·&nbsp; <a href="/">← Back to MotorQuoter</a>
        </p>
      </div>
    </>
  );
}
