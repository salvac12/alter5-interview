export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { fileBase64, filename } = req.body;
  if (!fileBase64 || !filename) return res.status(400).json({ error: 'Missing required fields' });
  if (String(filename).length > 255) return res.status(400).json({ error: 'Filename too long' });
  if (String(fileBase64).length > 10_000_000) return res.status(400).json({ error: 'File too large (max ~7MB)' });

  const isPDF = String(fileBase64).startsWith('JVBERi0') || String(filename).toLowerCase().endsWith('.pdf');

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'Service unavailable' });

  try {
    const content = [
      isPDF
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
        : { type: 'text', text: `Filename: ${String(filename).slice(0, 255)}` },
      {
        type: 'text',
        text: 'Extract the full name and email address from this CV. Respond ONLY with valid JSON: {"name": "Full Name", "email": "email@example.com"}. If you cannot find one of the fields, use an empty string. No other text.'
      }
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 300, messages: [{ role: 'user', content }] })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || 'API error' });
    }

    const data = await response.json();
    const text = data.content?.find(c => c.type === 'text')?.text || '{}';
    let parsed;
    try { parsed = JSON.parse(text.replace(/```json|```/g, '').trim()); }
    catch { parsed = extractFallback(text); }

    const name = String(parsed.name || '').slice(0, 100).replace(/[<>"'&]/g, '');
    const email = String(parsed.email || '').slice(0, 254);
    const emailRx = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
    const safeEmail = emailRx.test(email) ? email : '';

    if (!name && !safeEmail) return res.status(422).json({ error: 'No se pudo extraer nombre ni email del CV' });

    return res.status(200).json({ name, email: safeEmail });
  } catch (e) {
    console.error('process-cv error:', e.message);
    return res.status(500).json({ error: 'Service unavailable' });
  }
}

function extractFallback(text) {
  const email = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/)?.[0] || '';
  const name = text.match(/"name"\s*:\s*"([^"]+)"/)?.[1] || '';
  return { name, email };
}
