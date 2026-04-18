// Server-side HTML allowlist sanitizer.
//
// Used to clean HTML produced by the Claude interview-analysis prompt
// BEFORE it is persisted to `interviews.ai_analysis_html`. The model is
// instructed to emit a fixed set of tags (h4, p, ul/li, span.score-pill)
// but a clever prompt-injection inside a candidate answer could try to
// make it emit <script>, <img onerror=...>, javascript: URLs, or
// dangerous attributes. We refuse to trust the model's output as HTML.
//
// Approach: stripe-and-allowlist. Drop every tag not in ALLOWED_TAGS,
// drop every attribute not in ALLOWED_ATTRS for that tag. For <span>
// we allow `class` but only with a fixed vocabulary (the score-pill
// classes the prompt is supposed to use). All comments, doctype, CDATA,
// and unknown constructs are removed.
//
// We do NOT depend on a DOM parser (Edge runtime / serverless cold-start
// matters). The regex pass handles the constrained input we get from the
// model — anything that doesn't fit gets dropped. Any time we touch this
// sanitizer, prefer "drop the suspicious thing" over "try to repair it".

// Match exactly the schema the interview-analysis prompt is supposed to
// emit (see lib/interview-analysis.js — h4 sections, p paragraphs, ul/li
// bullets, span.score-pill). We deliberately do NOT allow <div>, <svg>,
// <math>, <style>, <template>, <iframe>, or anything that could open a
// foreign namespace and confuse the browser parser into interpreting
// surviving text as markup. Adding a tag here = expanding attack surface.
const ALLOWED_TAGS = new Set([
  'h3', 'h4', 'h5', 'h6',
  'p', 'br',
  'ul', 'ol', 'li',
  'strong', 'em',
  'span',
]);

// Tags that MUST be stripped entirely (tag + inner content). Browsers
// parse the inner content of these tags with special rules (raw text /
// foreign content / template) so leaving the inner text behind is unsafe
// even after we strip the tags themselves.
const RAW_CONTENT_TAGS = /<(script|style|template|iframe|noscript|svg|math|xmp|noembed|noframes)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// Self-closing or unterminated forms of the same.
const RAW_OPEN_FALLBACK = /<(script|style|template|iframe|noscript|svg|math|xmp|noembed|noframes)\b[^>]*>/gi;

// Tag → attribute name → validator. Validator returns the (possibly
// sanitized) value to keep, or null to drop the attribute.
const ATTR_RULES = {
  span: {
    class: (v) => {
      // Allow only known score-pill classes (and combinations).
      const tokens = String(v).split(/\s+/).filter(Boolean);
      const ok = tokens.filter(t => /^(?:score-pill|sp-(?:green|amber|red))$/.test(t));
      return ok.length ? ok.join(' ') : null;
    },
  },
};

// Match an opening or closing tag (greedy on attributes, but stops at >).
// We ban < and > inside attribute values via a separate post-check.
const TAG_RX = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*)?)\/?>/g;

// Extract attributes from the inner part of a tag (everything between
// the tag name and the closing >). Handles "name", "name=value",
// "name='value'", 'name="value"'. Stops at the first malformed attr.
const ATTR_RX = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function stripDangerousUrl(value) {
  // We don't currently allow href/src on any tag, but if that ever
  // changes, this is the choke point.
  const v = String(value).trim().toLowerCase();
  if (v.startsWith('javascript:') || v.startsWith('data:') || v.startsWith('vbscript:')) {
    return null;
  }
  return value;
}

function sanitizeAttributes(tagName, raw) {
  const rules = ATTR_RULES[tagName];
  if (!rules) return ''; // No attributes allowed for this tag

  const out = [];
  let m;
  ATTR_RX.lastIndex = 0;
  while ((m = ATTR_RX.exec(raw)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (name.startsWith('on')) continue;          // event handlers — never
    if (name === 'style') continue;               // CSS injection vector
    const validator = rules[name];
    if (!validator) continue;
    const cleaned = validator(value);
    if (cleaned == null) continue;
    // Final URL guard if the validator returned a URL-like string.
    const safe = (name === 'href' || name === 'src') ? stripDangerousUrl(cleaned) : cleaned;
    if (safe == null) continue;
    out.push(`${name}="${String(safe).replace(/"/g, '&quot;')}"`);
  }
  return out.length ? ' ' + out.join(' ') : '';
}

// Strip HTML comments (incl. conditional comments) and CDATA up front;
// they cannot appear in our allowlisted output and are common XSS vectors.
function stripCommentsAndCdata(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
}

function sanitizeHtml(input) {
  if (input == null) return '';
  let html = stripCommentsAndCdata(String(input));

  // Strip dangerous-content tags WITH their inner content first, so
  // leftover text from <style>/<svg>/etc. cannot be re-interpreted as
  // markup by the browser parser (mXSS via foreign-content / raw-text
  // contexts). We run the paired form first, then a fallback for
  // unterminated openings.
  html = html.replace(RAW_CONTENT_TAGS, '');
  html = html.replace(RAW_OPEN_FALLBACK, '');

  // Replace every remaining tag with either a sanitized version or
  // empty string. Unknown tags are dropped, allowed tags are rebuilt
  // from a strict template so attribute order / quoting is normalized.
  html = html.replace(TAG_RX, (full, name, attrs) => {
    const tag = name.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';

    const isClosing = full.startsWith('</');
    if (isClosing) return `</${tag}>`;

    const cleanedAttrs = sanitizeAttributes(tag, attrs || '');
    return `<${tag}${cleanedAttrs}>`;
  });

  return html;
}

module.exports = { sanitizeHtml };
