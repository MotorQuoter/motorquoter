// Unit tests for the Free First Report pure surface (lib/freeReport.mjs + config blocklist).
// Deterministic signing key for the test run. Run: node scripts/validate-free-report.mjs
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-signing-key-fixed';
const { normaliseEmail, emailDomain, isValidEmail, signLink, verifyLink } = await import('../lib/freeReport.mjs');
const { DISPOSABLE_DOMAINS, FREE_REPORT_STRINGS } = await import('../config/freeReport.mjs');

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } };

console.log('── normaliseEmail ──');
check("gmail plus-tag stripped + lowercased + trimmed", normaliseEmail(' Vincent+salvage@Gmail.com ') === 'vincent@gmail.com');
check("plain address passes through", normaliseEmail('buyer@outlook.com') === 'buyer@outlook.com');
check("no plus untouched", normaliseEmail('a.b@domain.co.uk') === 'a.b@domain.co.uk');
check("emailDomain lowercased", emailDomain('X@Sub.Example.COM') === 'sub.example.com');

console.log('\n── isValidEmail ──');
check("valid", isValidEmail('a@b.co') === true);
check("no @", isValidEmail('ab.co') === false);
check("no tld", isValidEmail('a@b') === false);
check("empty", isValidEmail('') === false);

console.log('\n── disposable blocklist ──');
check("mailinator blocked", DISPOSABLE_DOMAINS.has('mailinator.com'));
check("gmail not blocked", !DISPOSABLE_DOMAINS.has('gmail.com'));

console.log('\n── signLink / verifyLink ──');
const now = 1_000_000;
const sig = signLink({ email: 'vincent@gmail.com', optIn: true, expMs: now + 1000 });
const okV = verifyLink(sig, now);
check("round-trip ok", okV.ok === true && okV.email === 'vincent@gmail.com' && okV.optIn === true);
check("expired rejected", verifyLink(sig, now + 2000).ok === false && verifyLink(sig, now + 2000).reason === 'expired');
check("tampered signature rejected", verifyLink(sig.slice(0, -2) + 'xx', now).ok === false);
const [b] = sig.split('.');
check("tampered payload rejected", verifyLink(`${b}.deadbeef`, now).reason === 'bad-signature');
check("malformed (no dot) rejected", verifyLink('garbage', now).reason === 'malformed');
check("null sig rejected", verifyLink(null, now).ok === false);
check("optIn=false round-trips", verifyLink(signLink({ email: 'a@b.co', optIn: false, expMs: now + 1000 }), now).optIn === false);

console.log('\n── locked strings present ──');
check("neutral string set", /verification link is on its way/.test(FREE_REPORT_STRINGS.neutral));
check("globalCap string set", /more available tomorrow/.test(FREE_REPORT_STRINGS.globalCap));
check("disposable string set", /non-disposable email address/.test(FREE_REPORT_STRINGS.disposable));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
