export default function TermsPage() {
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
          <h1 className="hero-title">Terms &amp; Conditions</h1>
        </div>

        <div className="content">
          <div className="section">
            <div className="section-heading">General Disclaimer</div>
            <p className="section-body">MotorQuoter is an information service. All data provided is sourced from third party data suppliers including Experian Automotive, Brego, Cazana (Percayso), the DVLA, and the DVSA. MotorQuoter does not guarantee the accuracy, completeness, or currency of any data returned. Users should independently verify all information before making any purchasing, bidding, or financial decision.</p>
          </div>

          <div className="section">
            <div className="section-heading">Not Financial Advice</div>
            <p className="section-body">The valuations, bid intelligence, and market data provided by MotorQuoter are for informational purposes only. Nothing on this page constitutes financial advice, investment advice, or a recommendation to buy, sell, or bid on any vehicle. MotorQuoter accepts no liability for any financial loss arising from reliance on data provided through this service.</p>
          </div>

          <div className="section">
            <div className="section-heading">Valuation Disclaimer</div>
            <p className="section-body">Retail and trade valuations are algorithmic estimates based on current market data. Actual sale prices may vary significantly depending on vehicle condition, location, demand, and market conditions at the time of sale. Valuations are not formal appraisals and should not be relied upon as such.</p>
          </div>

          <div className="section">
            <div className="section-heading">Bid Intelligence / Salvage Disclaimer</div>
            <p className="section-body">Salvage auction predictions and hammer price estimates are based on historical auction data and current market conditions. Actual hammer prices may differ materially. Repair cost estimates are indicative ranges only and are not formal repair quotations. MotorQuoter accepts no liability for any loss arising from bidding decisions made using data provided through this service.</p>
          </div>

          <div className="section">
            <div className="section-heading">Vehicle History Disclaimer</div>
            <p className="section-body">Vehicle history data is sourced from Experian Automotive and other third party databases. While every effort is made to ensure accuracy, MotorQuoter cannot guarantee that all finance, stolen, write-off, or mileage records are complete or current. A clear result does not guarantee a vehicle is free from undisclosed issues. Always carry out a physical inspection before purchase.</p>
          </div>

          <div className="section">
            <div className="section-heading">Service History Disclaimer</div>
            <p className="section-body">Digital service history is available for selected vehicle makes only. The absence of a digital service history record does not indicate that no physical service history exists. MotorQuoter cannot verify or guarantee the accuracy of service records returned by third party systems.</p>
          </div>

          <div className="section">
            <div className="section-heading">ROI / VRT Disclaimer</div>
            <p className="section-body">Vehicle Registration Tax calculations are estimates based on Revenue Ireland rates current at the time of the lookup. VRT rates and Open Market Selling Price valuations are subject to change. Users should verify current VRT liability directly with Revenue Ireland or a licensed VRT assessor before importing any vehicle. MotorQuoter accepts no liability for any VRT liability arising from reliance on estimates provided through this service.</p>
          </div>

          <div className="section">
            <div className="section-heading">Terms of Use</div>
            <p className="section-body">MotorQuoter is provided on an &ldquo;as is&rdquo; basis. No warranty of fitness for purpose is given. Maximum liability is limited to the amount paid for the check in question. Data must not be resold or redistributed. One check result per payment — results are for the purchasing user only. MotorQuoter reserves the right to withdraw or amend the service at any time.</p>
          </div>
        </div>

        <p className="footer-note">
          Not affiliated with Copart, CAP or HPI.<br />
          <a href="/">← Back to MotorQuoter</a>
        </p>
      </div>
    </>
  );
}
