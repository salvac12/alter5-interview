// CV analysis via Claude. Pure function — no DB side effects.
//
// Input: { fileBase64, filename }
// Output: { ok, name, email, score, recommendation, summary, raw, model }

const MODEL = 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT = `Eres un recruiter senior especializado en perfiles tech de nivel C-level y arquitectura de software.

Tu tarea: analizar un CV y evaluar el fit del candidato para esta posicion:

POSICION: SW Architect / AI Head of Engineering
EMPRESA: Alter5 — fintech de banca de inversion, Madrid (100% remoto)
REQUISITOS CLAVE:
- Arquitectura de software: microservicios, AWS (App Runner, RDS, ECS), PostgreSQL, observabilidad
- IA aplicada: experiencia real con LLMs, agentes, orquestacion (LangChain, CrewAI, Vercel AI SDK, etc.)
- Liderazgo: experiencia gestionando equipos de desarrollo (>3 personas), procesos remotos, evaluacion de rendimiento
- Producto: capacidad de colaborar con negocio, traducir necesidades en decisiones tecnicas
- Dedicacion exclusiva obligatoria
- Experiencia minima: 8+ anos en desarrollo, 3+ en roles de liderazgo tecnico

RESPONDE SOLO con JSON valido, sin texto adicional:
{
  "name": "Nombre completo del candidato",
  "email": "email@encontrado.com",
  "fit_score": 8,
  "fit_recommendation": "enviar",
  "fit_summary": "2-3 frases explicando el fit"
}

REGLAS para fit_score (1-10):
- 8-10: Encaja muy bien. Experiencia directa en la mayoria de requisitos clave.
- 7:    Buen encaje. Cumple la mayoria de requisitos con algun matiz.
- 4-6:  Fit parcial. Tiene experiencia tecnica pero le faltan areas relevantes.
- 1-3:  No encaja. Perfil muy alejado de los requisitos.

REGLAS para fit_recommendation:
- "enviar":    fit_score >= 7. Merece la entrevista directa.
- "revisar":   fit_score 4-6. Revision manual antes de decidir.
- "descartar": fit_score <= 3.

Se exigente pero justo. No infles puntuaciones. Si el CV no muestra evidencia de algo, no lo asumas.
Si no encuentras nombre o email, usa cadena vacia.`;

function extractFallback(text) {
  const email = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/)?.[0] || '';
  const name = text.match(/"name"\s*:\s*"([^"]+)"/)?.[1] || '';
  return { name, email, fit_score: 1, fit_recommendation: 'revisar', fit_summary: 'No se pudo analizar el CV automaticamente.' };
}

async function analyzeCv({ fileBase64, filename }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: 'missing_api_key' };
  if (!fileBase64) return { ok: false, error: 'missing_file' };

  const isPDF = String(fileBase64).startsWith('JVBERi0') || String(filename || '').toLowerCase().endsWith('.pdf');

  const content = [
    isPDF
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
      : { type: 'text', text: `Filename: ${String(filename || '').slice(0, 255)}` },
    { type: 'text', text: 'Analiza este CV segun las instrucciones del sistema. Responde SOLO con el JSON.' },
  ];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { ok: false, error: err.error?.message || `api_error_${response.status}` };
    }

    const data = await response.json();
    const text = data.content?.find(c => c.type === 'text')?.text || '{}';
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      parsed = extractFallback(text);
    }

    const name = String(parsed.name || '').slice(0, 100).replace(/[<>"'&]/g, '');
    const email = String(parsed.email || '').slice(0, 254);
    const emailRx = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
    const safeEmail = emailRx.test(email) ? email : '';

    const score = Math.min(10, Math.max(1, parseInt(parsed.fit_score) || 1));

    // Normalize recommendation based on new thresholds: >=7 enviar, 4-6 revisar, <=3 descartar.
    const rec = score >= 7 ? 'enviar' : score >= 4 ? 'revisar' : 'descartar';
    const summary = String(parsed.fit_summary || 'No se pudo analizar el fit.').slice(0, 500);

    return {
      ok: true,
      name,
      email: safeEmail,
      score,
      recommendation: rec,
      summary,
      raw: parsed,
      model: MODEL,
    };
  } catch (e) {
    return { ok: false, error: e.message || 'network_error' };
  }
}

module.exports = { analyzeCv, MODEL };
