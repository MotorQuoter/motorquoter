const { test, expect } = require('@playwright/test');

// Session f20cb68a: rerun_count=0, status=assessed, promo auth.
// Re-run button is visible on load. Route intercept forces a 403 so no DB row is consumed.
const SALVAGE_ID  = 'f20cb68a-e8b7-40e5-b117-7bd4511d2e74';
const PROMO_TOKEN = '01c349a9-fbd7-4afb-af9d-212bb482caad';

test('2nd re-run: shows "Re-run Limit Reached", no Retry button', async ({ page }) => {
  await page.route('**/api/salvage/rerun', route =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Re-run limit reached' }),
    })
  );

  await page.goto(`/salvage/success?salvage_id=${SALVAGE_ID}&promo_token=${PROMO_TOKEN}`);

  // Confirm success page fully loaded and Re-run button is present (rerunCount=0)
  await page.waitForSelector('.btn-rerun', { timeout: 60_000 });

  await page.click('.btn-rerun');

  await page.waitForSelector('.error-box');

  await expect(page.locator('.error-title')).toHaveText('Re-run Limit Reached');
  await expect(page.locator('.error-msg')).toHaveText("You've used your free re-run for this assessment.");
  await expect(page.locator('.btn-retry')).toHaveCount(0);
});
