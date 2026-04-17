// End-to-end smoke tests for the candidate-driven Alter5 hiring platform.
//
// These tests are read-only against production (or a preview deploy via
// PLAYWRIGHT_BASE_URL). They avoid submitting any data — the ARCO and
// apply endpoints always return `{ok:true}` even without a real record,
// so we can safely exercise the happy paths without seeding.

const { test, expect } = require('@playwright/test');

const BASE =
  process.env.PLAYWRIGHT_BASE_URL || 'https://alter5-interview.vercel.app';

const SEC_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function assertSecurityHeaders(resp) {
  const h = resp.headers();
  for (const [k, v] of Object.entries(SEC_HEADERS)) expect(h[k]).toBe(v);
  expect(h['strict-transport-security']).toBeDefined();
}

test.describe('Public pages', () => {
  test('/sw-architect landing page loads', async ({ page }) => {
    const r = await page.goto(`${BASE}/sw-architect`);
    expect(r.status()).toBe(200);
    assertSecurityHeaders(r);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Must expose the privacy management link
    await expect(page.locator('a[href="/privacy/my-data"]').first()).toBeVisible();
  });

  test('/apply/privacy shows GDPR annex', async ({ page }) => {
    const r = await page.goto(`${BASE}/apply/privacy`);
    expect(r.status()).toBe(200);
    await expect(page.locator('body')).toContainText(/RGPD|GDPR|privacidad/i);
    await expect(page.locator('a[href^="mailto:privacy@alter-5.com"]').first()).toBeVisible();
  });

  test('/privacy/my-data without token renders request form', async ({ page }) => {
    const r = await page.goto(`${BASE}/privacy/my-data`);
    expect(r.status()).toBe(200);
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#btn-request')).toBeVisible();
  });

  test('/privacy/my-data with bogus token shows invalid screen', async ({ page }) => {
    // 64-hex to pass client-side format check, but not in DB
    const fake = 'a'.repeat(64);
    await page.goto(`${BASE}/privacy/my-data?token=${fake}`);
    await expect(page.locator('#mode-invalid')).toBeVisible({ timeout: 10000 });
  });

  test('/interview without token shows blocker', async ({ page }) => {
    const r = await page.goto(`${BASE}/interview`);
    expect(r.status()).toBe(200);
    // Without a token the interview page must not advance to questions.
    await expect(page.locator('text=/enlace|token|inválido|caducado/i').first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Admin / restricted pages', () => {
  test('/admin requires Basic Auth', async ({ request }) => {
    const r = await request.get(`${BASE}/admin`, { failOnStatusCode: false });
    expect(r.status()).toBe(401);
    expect(r.headers()['www-authenticate']).toMatch(/Basic/);
  });

  test('/reports requires Basic Auth', async ({ request }) => {
    const r = await request.get(`${BASE}/reports`, { failOnStatusCode: false });
    expect(r.status()).toBe(401);
  });

  test('/api/admin/* requires Basic Auth', async ({ request }) => {
    const r = await request.get(`${BASE}/api/admin/stats`, { failOnStatusCode: false });
    expect(r.status()).toBe(401);
  });
});

test.describe('Public API safety', () => {
  test('/api/public-config exposes only safe keys', async ({ request }) => {
    const r = await request.get(`${BASE}/api/public-config`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    // Whitelist: never leak service keys
    const allowed = new Set(['turnstile_site_key', 'apply_base_url', 'booking_url']);
    for (const k of Object.keys(body)) {
      expect(allowed.has(k), `unexpected key: ${k}`).toBeTruthy();
    }
  });

  test('/api/privacy/request-access returns {ok:true} for any email (no enumeration)', async ({ request }) => {
    const r = await request.post(`${BASE}/api/privacy/request-access`, {
      data: { email: `nobody-${Date.now()}@example.com` },
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
  });

  test('/api/privacy/data with invalid token returns {ok:false}', async ({ request }) => {
    const r = await request.post(`${BASE}/api/privacy/data`, {
      data: { token: 'a'.repeat(64) },
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(['not_found', 'expired', 'used', 'invalid']).toContain(body.reason);
  });

  test('/api/interview/validate with invalid token returns {ok:false}', async ({ request }) => {
    const r = await request.post(`${BASE}/api/interview/validate`, {
      data: { token: 'a'.repeat(64) },
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(false);
  });

  test('/api/cron/purge-expired rejects unauthenticated calls', async ({ request }) => {
    const r = await request.get(`${BASE}/api/cron/purge-expired`, { failOnStatusCode: false });
    expect(r.status()).toBe(401);
  });

  test('apply endpoint rate-limits aggressive callers', async ({ request }) => {
    // 10 rapid-fire calls; threshold is 5/min. We must see at least one 429.
    const results = [];
    for (let i = 0; i < 10; i++) {
      const r = await request.post(`${BASE}/api/apply`, {
        data: { email: 'badly-formed' },
        failOnStatusCode: false,
      });
      results.push(r.status());
    }
    expect(results.some(s => s === 429)).toBeTruthy();
  });
});

test.describe('Security headers', () => {
  for (const path of ['/sw-architect', '/apply/privacy', '/privacy/my-data', '/interview']) {
    test(`security headers on ${path}`, async ({ page }) => {
      const r = await page.goto(`${BASE}${path}`);
      assertSecurityHeaders(r);
    });
  }
});
