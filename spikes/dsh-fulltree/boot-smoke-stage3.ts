// Boot smoke for cordis.yml with the web cluster (dsh-web + dsh-web-fetch-http
// + dsh-tool-web) added. Boot must succeed; ctx.web must be present; the
// 'http' fetch provider must be registered. (No search provider —
// dsh-web-search-deepseek is deliberately not mounted: it needs the real
// DeepSeek Anthropic-Messages endpoint with web_search server tool, which our
// local 127.0.0.1:9999 chat-completions gateway doesn't speak.)
import { boot } from '@deepseek-ai/dsh-app-boot';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const cfg = resolve(projectRoot, 'resources/dsh/cordis.yml');
const bareBase = new URL('.', pathToFileURL(projectRoot).href).href;

try {
  const ctx = await boot('thihy-smoke-s3', cfg, undefined, undefined, bareBase);
  const web = ctx.get('web') as {
    fetchProviders?: Map<string, unknown>;
    searchProviders?: Map<string, unknown>;
    fetchProviderId?: string;
    searchProviderId?: string;
  } | undefined;
  console.log('[s3] ctx.web:', web ? 'present' : 'ABSENT');
  if (!web) { console.error('[s3] FAIL: ctx.web missing'); process.exit(2); }
  const fetchIds = web.fetchProviders ? Array.from(web.fetchProviders.keys()) : [];
  const searchIds = web.searchProviders ? Array.from(web.searchProviders.keys()) : [];
  console.log('[s3] registered fetch providers:', fetchIds.join(', ') || '(none)');
  console.log('[s3] registered search providers:', searchIds.join(', ') || '(none)');
  console.log('[s3] configured fetchProviderId:', web.fetchProviderId);
  console.log('[s3] configured searchProviderId:', web.searchProviderId);
  if (!fetchIds.includes('http')) {
    console.error('[s3] FAIL: http fetch provider not registered');
    process.exit(3);
  }
  // tools and systemPrompt are the other inject deps for dsh-tool-web
  console.log('[s3] ctx.tools:', ctx.get('tools') ? 'present' : 'ABSENT');
  console.log('[s3] ctx.systemPrompt:', ctx.get('systemPrompt') ? 'present' : 'ABSENT');
  await ctx.fiber?.dispose?.();
  console.log('[s3] OK');
} catch (err) {
  console.error('[s3] FAIL:', (err as Error).message);
  console.error((err as Error).stack);
  process.exit(1);
}
