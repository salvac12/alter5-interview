// End-to-end smoke tests for the candidate-driven Alter5 hiring platform.
//
// These tests are read-only against production (or a preview deploy via
// PLAYWRIGHT_BASE_URL). They avoid submitting any data — the ARCO and
// apply endpoints always return `{ok:true}` even without a real record,
// so we can safely exercise the happy paths without seeding.

const { test, expect } = require('@playwright/test');

const BASE =
  process.env.PLAYWRIGHT_BASE_URL || 'https://careers.alter-5.com';

const SEC_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function assertSecurityHeaders(resp) {
  const h = resp.headers();
  for (const [k, v] of Object.entries(SEC_HEADERS)) expect(h[k]).toBe(v);
  expect(h['strict-transport-security']).toBeDefined();
  // Hardened headers landed in commit 694b3b6 — guard against silent
  // regressions that strip CSP/COOP/CORP from the global header block.
  expect(h['content-security-policy']).toContain("default-src 'self'");
  expect(h['content-security-policy']).toContain('https://challenges.cloudflare.com');
  expect(h['cross-origin-opener-policy']).toBe('same-origin');
  expect(h['cross-origin-resource-policy']).toBe('same-origin');
}

test.describe('Public pages', () => {
  test('/hoe landing page loads', async ({ page }) => {
    const r = await page.goto(`${BASE}/hoe`);
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
    // Without a token the interview page must not advance to questions —
    // it must show the blocker screen with an "Enlace …" title.
    await expect(page.locator('#screen-blocker')).toHaveClass(/active/, { timeout: 10000 });
    await expect(page.locator('#blocker-title')).toBeVisible();
    await expect(page.locator('#blocker-title')).toHaveText(/enlace|token|inválido|caducado/i);
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
    // 429 is also a valid security outcome (rate limiter is working).
    expect([200, 429]).toContain(r.status());
    if (r.status() === 200) {
      const body = await r.json();
      expect(body.ok).toBe(true);
    }
  });

  test('/api/privacy/data with invalid token returns {ok:false}', async ({ request }) => {
    const r = await request.post(`${BASE}/api/privacy/data`, {
      data: { token: 'a'.repeat(64) },
    });
    // 429 is also a valid security outcome (rate limiter is working).
    expect([200, 429]).toContain(r.status());
    if (r.status() === 200) {
      const body = await r.json();
      expect(body.ok).toBe(false);
      expect(['not_found', 'expired', 'used', 'invalid']).toContain(body.reason);
    }
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

  test('/sw-architect legacy URL 308-redirects to /hoe', async ({ request }) => {
    // Old public URL was renamed; the redirect must remain in place so any
    // links that escaped into the wild keep landing on the form. 308
    // (Permanent Redirect) preserves both method and SEO juice.
    const r = await request.get(`${BASE}/sw-architect`, {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(r.status()).toBe(308);
    expect(r.headers()['location']).toMatch(/\/hoe$/);
  });

  test('/api/upload-cv rejects unauthenticated POST', async ({ request }) => {
    // Should not accept arbitrary uploads without an apply session.
    const r = await request.post(`${BASE}/api/upload-cv`, {
      data: {},
      failOnStatusCode: false,
    });
    // Either 400 (missing fields) or 401/403 (gated). Anything else (e.g.
    // 200) means the endpoint is wide open.
    expect([400, 401, 403, 429]).toContain(r.status());
  });

  test('/api/submit-interview with garbage token does not 200', async ({ request }) => {
    const r = await request.post(`${BASE}/api/submit-interview`, {
      data: { token: 'a'.repeat(64), answers: {} },
      failOnStatusCode: false,
    });
    // 400/401/403/429 all acceptable — anything but a successful submit.
    expect([400, 401, 403, 404, 429]).toContain(r.status());
  });

  test('/apply/verify routes to handler (not 404) and redirects', async ({ request }) => {
    // Magic-link emails point candidates at /apply/verify?token=... — the
    // handler lives at /api/apply/verify and is reached via vercel.json
    // rewrite. Regression guard: the previous rewrite gap returned a hard
    // 404 with the user staring at "NOT_FOUND" on Gmail's mobile preview.
    const r = await request.get(`${BASE}/apply/verify?token=${'a'.repeat(64)}`, {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(r.status(), `expected 302 redirect, got ${r.status()} (404 means rewrite is missing)`).toBe(302);
    expect(r.headers()['location']).toMatch(/\/apply\/verify-failed/);
  });

  test('/api/privacy/delete with invalid token returns {ok:false}', async ({ request }) => {
    const r = await request.post(`${BASE}/api/privacy/delete`, {
      data: { token: 'a'.repeat(64) },
      failOnStatusCode: false,
    });
    expect([200, 429]).toContain(r.status());
    if (r.status() === 200) {
      const body = await r.json();
      expect(body.ok).toBe(false);
    }
  });

  test('/privacy/my-data surfaces a clear message when delete is rate-limited (429)', async ({ page }) => {
    // Regression guard for commit 4874968: the edge limiter (5 req/min on
    // /api/privacy/*) used to return {error:"Too many requests"}, which
    // has no .reason, so the UI fell through to the generic "No se ha
    // podido procesar el borrado." — masking the real cause. Now the
    // frontend handles r.status===429 explicitly. If this test fails, the
    // 429 branch was removed or the message changed.
    const fake = 'a'.repeat(64);
    await page.route('**/api/privacy/delete', route =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Too many requests' }),
      }),
    );
    await page.goto(`${BASE}/privacy/my-data?token=${fake}`);
    // Wait for the data-load step to settle (it'll show mode-invalid for our
    // fake token), then force the data view to be visible so we can click
    // "Borrar mis datos". Easier than wiring a real ARCO link.
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => {
      ['mode-request','mode-loading','mode-data','mode-invalid','mode-deleted']
        .forEach(m => document.getElementById(m).classList.toggle('hide', m !== 'mode-data'));
    });
    page.once('dialog', d => d.accept());
    await page.locator('#btn-delete').click();
    await expect(page.locator('#delete-msg')).toContainText(/demasiadas peticiones/i, { timeout: 5000 });
  });
});

test.describe('Security headers', () => {
  for (const path of ['/hoe', '/apply/privacy', '/privacy/my-data', '/interview']) {
    test(`security headers on ${path}`, async ({ page }) => {
      const r = await page.goto(`${BASE}${path}`);
      assertSecurityHeaders(r);
    });
  }
});
