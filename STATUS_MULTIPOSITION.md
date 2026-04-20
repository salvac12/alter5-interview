# Multi-position v1 — punto de situación

**Rama:** `staging` (10 commits por delante de `main`, todos en `origin/staging`).
**Preview (staging):** https://alter5-interview-6w60n4aw3-salvas-workspaces-projects.vercel.app
**Inspector:** https://vercel.com/salvas-workspaces-projects/alter5-interview/6fy9mAjGYUrgrLuC9zjAmdRyMFt4

---

## Qué está hecho

- Tabla `positions` + migración con seed HoE verbatim (prompts CV/entrevista, blocks, 16 preguntas).
- `lib/cv-analysis.js` y `lib/interview-analysis.js` aceptan `systemPrompt` override.
- `api/apply.js`, `lib/cv-upload.js`, `api/submit-interview.js`, `api/admin/reanalyze-interview.js` cargan prompt desde la posición.
- `GET /api/interview/config?token=…` → `interview.html` ya no hardcodea preguntas.
- CRUD admin de posiciones (`/api/admin/positions*`) + validación JSON (`lib/position-validation.js`).
- Landing pública `/positions/<slug>` con `public_intro_html` sanitizado vía DOMPurify.
- Tab "Posiciones" en `/admin` + dropdown global Cola/Todas/Entrevistas/Headhunters (persiste en localStorage).
- Detalle de candidato muestra la posición.
- Portal headhunter + upload manual admin: dropdown de posiciones, server revalida `share_with_headhunters`.
- Emails (`sendMagicLinkEmail`, `sendInterviewLinkEmail`) llevan `positionTitle` escapado en subject+header.
- Review fixes (`bc35432`): escape en `brandHeader`, DB-source-of-truth en re-apply, migración idempotente, DOMPurify en `public_intro_html`.
- **Migración aplicada a Supabase prod** (2026-04-20, confirmado vía `supabase migration list`).
- **Spec Playwright `tests/positions.spec.js`** (commit `fafb61e`) cubre las 5 deudas: `positions-admin-crud`, `positions-public-apply`, `interview-config-fetch`, `headhunter-position-picker`, `positions-reapply-idempotency`. Usa el secret de Vercel Deployment Bypass.
- **Smoke programático:** 5/5 contra Preview. Valida `/positions/hoe` renderiza con título HoE, `/api/interview/config` rechaza token bogus (404 JSON sin leak de preguntas), `/api/apply` responde 400 `turnstile_failed` con token inválido (no crashea), `/partners/upload` carga, `/api/admin/positions` devuelve 401 sin basic auth.

## Qué NO está hecho (consciente / v2)

- `correct` de las preguntas sigue llegando al cliente (scoring client-side). Deuda documentada.
- `positions` tiene RLS habilitado **sin policies** — sólo service role accede. Si algún día se expone con anon-key, hace falta policy.
- Rate limits específicos en `/api/admin/positions*` / `/api/positions*` — Task #64 pendiente.
- **Smoke manual end-to-end** (crear posición nueva, apply con Turnstile real, CV con prompt custom, entrevista completa con Anthropic, headhunter upload real) NO ejecutado todavía. El spec Playwright es lenient en estos caminos porque el Preview no tiene captcha-solver ni sesión admin-session.

---

## Cómo entrar al staging (Preview)

El Preview está detrás de Vercel SSO. Para saltarte el login:

**URL de entrada (setea cookie `_vercel_jwt`, dura 7 días):**
```
https://alter5-interview-6w60n4aw3-salvas-workspaces-projects.vercel.app/?x-vercel-protection-bypass=<secret>&x-vercel-set-bypass-cookie=true
```
El secret está en `.env.local` como `VERCEL_AUTOMATION_BYPASS_SECRET`. Después de la primera visita, navegas libre en el subdominio.

**Admin:** `/admin` → user `admin`, password = `ADMIN_PASS` (mismo valor que prod; encrypted en Vercel, lo tienes en tu keychain).

---

## Lo que queda por hacer

### 1. Smoke E2E manual sobre Preview (opcional si ya confías en el spec Playwright)

1. `/admin` → tab "Posiciones" aparece, fila `hoe` con N candidatos = total apps históricas.
2. `/hoe` → apply normal funciona. Candidato nuevo con `position_id` de HoE.
3. En admin, "Nueva posición" → slug `senior-backend`, duplicar desde HoE, editar preguntas (dejar 3 dummy), guardar.
4. Abrir `/positions/senior-backend` → landing renderiza, apply funciona.
5. Verify email → upload CV → `analyses` fila nueva usa el prompt de senior-backend.
6. Cola filtrada por "senior-backend" → sólo el candidato nuevo.
7. Aprobar → invitar → `/interview?token=…` → aparecen las 3 preguntas dummy (no las 16 de HoE).
8. Completar entrevista → `interviews.ai_analysis_html` generado con prompt de senior-backend.
9. `/partners/upload` → dropdown muestra sólo posiciones con `share_with_headhunters=true`.

### 2. Merge a main

```
git checkout main
git merge --ff-only staging
git push origin main
```

Vercel desplegará prod automáticamente. La migración ya está en prod, el merge es seguro.

### 3. Si algo revienta

- `git log origin/main..staging` enseña los 10 commits.
- Revertir feature aislada: `git revert <hash>` y push.
- Rollback rápido: redeploy del último deployment verde desde el dashboard de Vercel.

---

## Archivos clave

**Nuevos:** `supabase/migrations/20260420100000_positions.sql`, `lib/position-validation.js`, `lib/positions.js`, `api/admin/positions*.js`, `api/positions/[slug].js`, `api/positions/index.js`, `api/interview/config.js`, `positions.html`, `tests/positions.spec.js`.

**Modificados:** `lib/cv-analysis.js`, `lib/interview-analysis.js`, `lib/email.js`, `lib/cv-upload.js`, `api/apply.js`, `api/upload-cv.js`, `api/submit-interview.js`, `api/admin/reanalyze-interview.js`, `api/admin/manual-upload.js`, `api/admin/applications.js`, `api/admin/application.js`, `api/headhunter/upload-cv.js`, `interview.html`, `partners-upload.html`, `hoe.html`, `admin.html`, `middleware.js`, `vercel.json`.
