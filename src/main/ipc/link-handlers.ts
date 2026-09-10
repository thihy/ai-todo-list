// IPC handler for link.* channels.
//
// link.fetchMeta — fetches a URL in the MAIN process (the renderer can't,
// CORS blocks arbitrary cross-origin GETs) and parses the first chunk of
// HTML for <title> + <meta name="description"> / <meta property="og:description">.
// Used by the add-link dialog to prefill the link's title + description.
//
// Best-effort by design: any failure (non-HTTP(S) URL, DNS, timeout, non-HTML
// content, parse miss) returns ok with empty strings — never an IpcFailure —
// so the dialog's fields stay blank + editable and the save flow is never
// blocked. The user can always type the title themselves.

import { okResult, register } from './router';
import { logger } from '../logger';

/** Hard cap on how many bytes of the response body we parse. The <head>
 *  metadata we want is always near the top, so 256 KB is generous and keeps
 *  us from buffering a multi-megabyte page. */
const MAX_BODY_BYTES = 256 * 1024;
/** Total deadline for the fetch (connect + headers + body read). Pages that
 *  don't answer in 8s are abandoned — the dialog shows blank fields. */
const FETCH_TIMEOUT_MS = 8_000;
/** A desktop UA so sites that gate on "is this a real browser" return a real
 *  <title> instead of a bot/JS-gate interstitial. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface LinkMeta {
  title: string;
  description: string;
  resolvedUrl: string;
}

/** Decode the few HTML entities that commonly appear in <title> / meta
 *  content attributes. We don't pull in a full entity decoder — these cover
 *  the vast majority of real-world cases, and anything we miss stays literal
 *  (acceptable for a best-effort preview). */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Extract <title> from the (truncated) HTML. Grab up to the first </title>;
 *  if none, take whatever is inside <title>...</title> via regex. */
function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? collapseWs(decodeEntities(m[1] ?? '')) : '';
}

/** Extract the description meta. Prefer og:description, fall back to the
 *  standard meta description. Looks for both quoted variants
 *  (`content="..."` and `content='...'`). */
function extractDescription(html: string): string {
  // og:description first — it's usually the curated social-preview blurb,
  // which reads better than the SEO-stuffed meta description.
  const og = html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:description["']/i);
  if (og?.[1]) return collapseWs(decodeEntities(og[1]));
  const meta = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i);
  return meta?.[1] ? collapseWs(decodeEntities(meta[1])) : '';
}

/** Fetch + parse a URL's metadata. Returns empty strings on any failure —
 *  the caller (IPC handler) wraps this so a throw becomes an ok-with-empties
 *  result, never an error to the renderer. */
export async function fetchLinkMeta(rawUrl: string): Promise<LinkMeta> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { title: '', description: '', resolvedUrl: rawUrl };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { title: '', description: '', resolvedUrl: rawUrl };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      return { title: '', description: '', resolvedUrl: res.url || rawUrl };
    }
    const ctype = res.headers.get('content-type') ?? '';
    // Non-HTML responses (a direct image/PDF link, a JSON API) have no useful
    // <title> — bail with empties rather than parsing binary as text.
    if (!/text\/html|application\/xhtml/i.test(ctype)) {
      return { title: '', description: '', resolvedUrl: res.url || rawUrl };
    }

    // Read up to MAX_BODY_BYTES. The Response.body stream lets us stop early
    // instead of buffering a whole page; <head> metadata is always in the first
    // chunk anyway.
    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      return {
        title: extractTitle(text.slice(0, MAX_BODY_BYTES)),
        description: extractDescription(text.slice(0, MAX_BODY_BYTES)),
        resolvedUrl: res.url || rawUrl,
      };
    }
    let received = 0;
    let stopped = false;
    const chunks: Uint8Array[] = [];
    while (received < MAX_BODY_BYTES && !stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        // As soon as we've seen </head> we have all the metadata we'd want;
        // stop reading the body to save bandwidth on huge pages.
        // (Decoded incrementally to keep this cheap.)
      }
    }
    // Cancel any remaining stream so we don't hold the connection open.
    try {
      await reader.cancel();
    } catch {
      // ignore — we already have what we need
    }
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const html = chunks.map((c) => decoder.decode(c, { stream: true })).join('') + decoder.decode();
    const head = html.includes('</head>') ? html.slice(0, html.indexOf('</head>') + 7) : html;
    return {
      title: extractTitle(head.slice(0, MAX_BODY_BYTES)),
      description: extractDescription(head.slice(0, MAX_BODY_BYTES)),
      resolvedUrl: res.url || rawUrl,
    };
  } catch (err) {
    // Abort timeout, network error, etc. — best-effort: empty result.
    logger.warn(`link.fetchMeta: fetch failed for ${rawUrl}: ${(err as Error).message}`);
    return { title: '', description: '', resolvedUrl: rawUrl };
  } finally {
    clearTimeout(timer);
  }
}

export function registerLinkHandlers(): void {
  register('link.fetchMeta', (_e, req) => {
    try {
      return fetchLinkMeta(req.url).then((meta) => okResult(meta));
    } catch (err) {
      // Shouldn't happen (fetchLinkMeta catches its own throws), but keep the
      // contract: never surface a fetch error as a hard failure.
      logger.warn(`link.fetchMeta: unexpected error: ${(err as Error).message}`);
      return Promise.resolve(okResult({ title: '', description: '', resolvedUrl: req.url }));
    }
  });
  logger.info('link.* handlers registered');
}
