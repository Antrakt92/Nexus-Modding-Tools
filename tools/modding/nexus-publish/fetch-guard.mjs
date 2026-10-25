// Network boundary around the unchanged official action. No URLs/response bodies enter errors.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API_ORIGIN = 'https://api.nexusmods.com';
// Official pinned schema specifies S3 multipart. The live Nexus API also issues
// canonical Cloudflare R2 endpoints (verified 2026-10-04); custom domains stay refused.
const S3_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)?s3(?:[.-][a-z]{2}(?:-[a-z]+)+-\d+)?\.amazonaws\.com$/;
const R2_HOST = /^(?:[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.)?[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/;
const forbiddenHeaders = ['authorization', 'proxy-authorization', 'cookie', 'cookie2', 'host'];

function denied() { throw new Error('Network boundary refused request or upload destination.'); }

function approvedURL(value, key) {
  if (typeof value !== 'string') denied();
  let url;
  try { url = new URL(value); } catch { denied(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) denied();
  // The Nexus key must never appear in a URL, including an API-issued storage URL.
  let decoded;
  try { decoded = decodeURIComponent(url.href); } catch { denied(); }
  if (key && (value.includes(key) || decoded.includes(key))) denied();
  for (const name of url.searchParams.keys()) {
    if (/^(apikey|api_key|authorization|cookie)$/i.test(name)) denied();
  }
  return url;
}

function storageURL(value, key) {
  const url = approvedURL(value, key);
  if (!S3_HOST.test(url.hostname) && !R2_HOST.test(url.hostname)) denied();
  return url.href;
}

async function boundedText(response, maximum) {
  const reader = response.body?.getReader();
  if (!reader) denied();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) denied();
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch { denied(); }
  finally {
    // Cancellation itself can stall on a hostile stream. Refusal must not wait
    // for the producer; also release ownership of the reader on every path.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function completionXML(request, response, parts) {
  if (typeof request !== 'string' || Buffer.byteLength(request) > 3_000_000) denied();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].includes(key.toUpperCase())));
  const result = spawnSync(process.env.NEXUS_PYTHON || 'python',
    ['-B', '-I', fileURLToPath(new URL('./completion-xml.py', import.meta.url))],
    { input: JSON.stringify({ request, response, parts }), env, timeout: 10000, maxBuffer: 1024, windowsHide: true });
  if (result.status !== 0 || result.error || result.stdout?.length || result.stderr?.length) denied();
}

export function installFetchGuard(nativeFetch = globalThis.fetch, apiKey = process.env.INPUT_API_KEY?.trim(),
  { archiveBytes = Number(process.env.NEXUS_ARCHIVE_BYTES), dispatcher } = {}) {
  let plan = null;
  let failed = false;
  async function guardedFetch(input, init = {}) {
    if (failed) denied();
    if (dispatcher && globalThis[Symbol.for('undici.globalDispatcher.1')] !== dispatcher) denied();
    const url = approvedURL(input instanceof Request ? input.url : String(input), apiKey);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const credentials = init.credentials ?? (input instanceof Request ? input.credentials : undefined);
    if (forbiddenHeaders.some(name => headers.has(name)) || credentials === 'include' || init.dispatcher) denied();
    if (url.origin === API_ORIGIN) {
      if (!apiKey || headers.get('apikey') !== apiKey || !url.pathname.startsWith('/v3/')) denied();
      headers.set('Application-Name', 'Nexus-Agent-Publication');
      headers.set('Application-Version', '1.0');
      if (url.pathname === '/v3/uploads/multipart' && method === 'POST') {
        let requested;
        try { requested = JSON.parse(init.body); } catch { denied(); }
        if (plan || !Number.isSafeInteger(archiveBytes) || archiveBytes <= 0
          || !/^[1-9][0-9]*$/.test(String(requested.size_bytes)) || Number(requested.size_bytes) !== archiveBytes) denied();
      }
      if (/^\/v3\/uploads\/[^/]+\/finalise$/.test(url.pathname)) {
        if (!plan?.completed || url.pathname !== `/v3/uploads/${plan.id}/finalise`) denied();
      }
    } else {
      if (headers.has('apikey') || headers.has('api_key')) denied();
      // Official storage behavior supplies only content headers, never credential/routing headers.
      for (const [name, value] of headers) {
        if (!['content-type', 'content-length'].includes(name) || (apiKey && value.includes(apiKey))) denied();
      }
      storageURL(url.href, apiKey);
      if (!plan) denied();
      const part = plan.parts.find(part => part.url === url.href);
      if (part && method === 'PUT') {
        const bytes = ArrayBuffer.isView(init.body) ? init.body.byteLength : -1;
        if (part.state !== 'pending' || bytes !== part.bytes || headers.get('content-length') !== String(part.bytes)) denied();
        // Reserve synchronously BEFORE awaiting fetch: concurrent duplicate sends are forbidden.
        part.state = 'sending';
      } else if (url.href === plan.complete && method === 'POST') {
        if (plan.completing || plan.completed || plan.parts.some(part => part.state !== 'done')
          || plan.parts.reduce((sum, part) => sum + part.bytes, 0) !== archiveBytes) denied();
        completionXML(init.body, null, plan.parts.map((part, index) => [index + 1, part.etag]));
        plan.completing = true;
      } else denied();
    }
    // The reviewed Node 24.13.0 built-in transport predates the keep-alive queue-poisoning fix.
    // Disable reuse on every upload/read/poll request, independently of dispatcher version.
    headers.set('Connection', 'close');
    // A native fetch redirect can retain custom apikey headers. Disable ALL redirects at transport.
    let response;
    try {
      response = await nativeFetch(input instanceof Request ? input : url.href,
        { ...init, headers, redirect: 'error', credentials: 'omit', ...(dispatcher ? { dispatcher } : {}) });
    } catch { failed = true; denied(); }
    // Also fail closed for injected transports that return a redirect instead of honoring redirect:error.
    if (response.status >= 300 && response.status < 400) denied();
    if (url.origin === API_ORIGIN && url.pathname === '/v3/uploads/multipart' && method === 'POST' && response.ok) {
      let data, text;
      // A cloned response tees the stream. Cancelling only the inspected branch
      // waits forever if the official action has not read the other branch yet.
      // Inspect the sole stream, then give the action the bounded buffered body.
      try { text = await boundedText(response, 4_000_000); ({ data } = JSON.parse(text)); } catch { failed = true; denied(); }
      if (!Array.isArray(data?.part_presigned_urls) || !data.part_presigned_urls.length) denied();
      if (!Number.isSafeInteger(archiveBytes) || archiveBytes <= 0
        || !Number.isSafeInteger(data.part_size_bytes) || data.part_size_bytes <= 0 || data.part_size_bytes > 64 * 1024 * 1024
        || data.part_presigned_urls.length > 10000
        || data.part_presigned_urls.length !== Math.ceil(archiveBytes / data.part_size_bytes)
        || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(data.id)) denied();
      // Validate the whole plan BEFORE allowing even the first part upload.
      const parts = data.part_presigned_urls.map(value => storageURL(value, apiKey));
      const complete = storageURL(data.complete_presigned_url, apiKey);
      if (new Set(parts).size !== parts.length || parts.includes(complete)) denied();
      const finish = new URL(complete);
      if (finish.searchParams.getAll('uploadId').length !== 1 || !finish.searchParams.get('uploadId') || finish.searchParams.has('partNumber')) denied();
      for (const [index, value] of parts.entries()) {
        const part = new URL(value);
        if (part.origin !== finish.origin || part.pathname !== finish.pathname
          || part.searchParams.getAll('uploadId').length !== 1 || part.searchParams.get('uploadId') !== finish.searchParams.get('uploadId')
          || part.searchParams.getAll('partNumber').length !== 1 || part.searchParams.get('partNumber') !== String(index + 1)) denied();
      }
      plan = { id: data.id, complete, completing: false, completed: false,
        parts: parts.map((url, index) => ({ url, bytes: Math.min(data.part_size_bytes, archiveBytes - index * data.part_size_bytes), state: 'pending', etag: null })) };
      response = new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    } else if (url.origin !== API_ORIGIN && plan) {
      const part = plan.parts.find(part => part.url === url.href);
      if (!response.ok) { failed = true; denied(); }
      if (part) {
        const etag = response.headers.get('ETag')?.replace(/^"|"$/g, '');
        if (!etag || !/^[A-Za-z0-9._-]{1,200}$/.test(etag)) { failed = true; denied(); }
        part.etag = etag;
        part.state = 'done';
      } else {
        try {
          completionXML(init.body, await boundedText(response, 65536), plan.parts.map((part, index) => [index + 1, part.etag]));
        } catch { failed = true; denied(); }
        plan.completed = true;
      }
    }
    return response;
  }
  globalThis.fetch = guardedFetch;
  return guardedFetch;
}
