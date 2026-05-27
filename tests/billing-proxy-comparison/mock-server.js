#!/usr/bin/env node
/**
 * Mock Anthropic API Server for Billing Proxy Comparison Tests
 *
 * Captures requests from proxy.js and Sub2API, provides comparison endpoint.
 * Zero dependencies — Node.js only.
 *
 * Endpoints:
 *   POST /v1/messages         — Capture request, return canned response
 *   GET  /captured/:source    — Return captured data for source
 *   POST /reset               — Clear all captures
 *   GET  /compare             — Compare proxy-js vs sub2api captures
 *   GET  /health              — Health check
 */

const http = require('http');

const PORT = parseInt(process.env.MOCK_PORT || '9999', 10);
const PROXY_JS_TOKEN = process.env.PROXY_JS_TOKEN || 'sk-ant-proxy-js-test-token';
const SUB2API_BILLING_TOKEN = process.env.SUB2API_BILLING_TOKEN || 'sk-ant-sub2api-test-token';

// ─── Capture Storage ──────────────────────────────────────────────────────────
const captures = {};

function resetCaptures() {
  for (const k of Object.keys(captures)) delete captures[k];
}

// ─── Canned Response ──────────────────────────────────────────────────────────
// Contains terms that SHOULD be reverse-mapped by both proxies, so we can
// verify that reverse mapping is consistent.

const CANNED_RESPONSE = {
  id: 'msg_test_mock_001',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-20250514',
  content: [
    {
      type: 'text',
      text: 'I\'ll use Bash to run the command. The OCPlatform tool is available. thread_id=abc123, worker_id=w1. HB_ACK received from PAssistant via skillhub.'
    },
    {
      type: 'tool_use',
      id: 'toolu_mock_001',
      name: 'Bash',
      input: { command: 'echo "OCPlatform test via routing layer"' }
    }
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: {
    input_tokens: 150,
    output_tokens: 42,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 80
  }
};

// SSE streaming events — contains terms that need reverse-mapping plus
// thinking blocks (which should NOT be reverse-mapped).
const SSE_EVENTS = [
  // message_start
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: 'msg_test_mock_stream_001',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 200, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 }
      }
    }
  },
  // thinking block start
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me analyze this. Bash is a good tool. OCPlatform reference inside thinking should NOT be changed.' } }
  },
  {
    event: 'content_block_stop',
    data: { type: 'content_block_stop', index: 0 }
  },
  // text block start
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Running Bash command now. OCPlatform detected. thread_id=xyz, worker_id=w2.' } }
  },
  {
    event: 'content_block_stop',
    data: { type: 'content_block_stop', index: 1 }
  },
  // tool_use block
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_mock_stream_001', name: 'Bash' } }
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":"echo OCPlatform"}' } }
  },
  {
    event: 'content_block_stop',
    data: { type: 'content_block_stop', index: 2 }
  },
  // message_delta (stop)
  {
    event: 'message_delta',
    data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 55 } }
  },
  // message_stop
  {
    event: 'message_stop',
    data: { type: 'message_stop' }
  }
];

function formatSSE(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ─── Body Parser ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function detectSource(req) {
  const authorization = String(req.headers.authorization || '');
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  if (token === PROXY_JS_TOKEN) return 'proxy-js';
  if (token === SUB2API_BILLING_TOKEN) return 'sub2api';

  return req.headers['x-test-source'] || 'unknown';
}

// ─── Deep Comparison ──────────────────────────────────────────────────────────

// Fields to skip during comparison
const SKIP_HEADERS = new Set([
  'x-stainless-runtime-version',  // proxy.js uses real node version vs Sub2API hardcodes v22.11.0
  'anthropic-beta',               // proxy.js merges client betas vs Sub2API uses required set
  'x-claude-code-session-id',     // random per instance
  'authorization',                 // different tokens
  'content-length',                // may differ due to metadata
  'host',                          // different upstream targets
  'connection',                    // transport-level
  'transfer-encoding',             // transport-level
  'x-test-source',                 // our test marker
  'accept-encoding',               // transport-level
]);

const SKIP_BODY_PATHS = new Set([
  'metadata.user_id',              // internal, order varies
  'metadata.device_id',            // random per instance
  'metadata.session_id',           // random per instance
]);

function deepDiff(a, b, path = '') {
  const diffs = [];
  if (a === b) return diffs;
  if (a === null || b === null || typeof a !== typeof b) {
    diffs.push({ path: path || '(root)', a, b });
    return diffs;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      diffs.push(...deepDiff(a[i], b[i], `${path}[${i}]`));
    }
    return diffs;
  }
  if (typeof a === 'object') {
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of allKeys) {
      const childPath = path ? `${path}.${key}` : key;
      diffs.push(...deepDiff(a[key], b[key], childPath));
    }
    return diffs;
  }
  // primitives
  if (a !== b) {
    diffs.push({ path: path || '(root)', a, b });
  }
  return diffs;
}

function compareCaptures() {
  const proxyData = captures['proxy-js'];
  const sub2apiData = captures['sub2api'];

  if (!proxyData && !sub2apiData) {
    return { status: 'no_data', message: 'No captures from either source', available_sources: Object.keys(captures) };
  }
  if (!proxyData) {
    return { status: 'missing', message: 'No capture from proxy-js', available_sources: Object.keys(captures) };
  }
  if (!sub2apiData) {
    return { status: 'missing', message: 'No capture from sub2api', available_sources: Object.keys(captures) };
  }

  const result = {
    status: 'compared',
    header_diffs: [],
    body_diffs: [],
    skipped_headers: [],
    skipped_body_paths: [],
    acceptable_diffs: [],
  };

  // --- Header comparison ---
  const allHeaders = new Set([
    ...Object.keys(proxyData.headers),
    ...Object.keys(sub2apiData.headers),
  ]);
  for (const h of allHeaders) {
    const lh = h.toLowerCase();
    if (SKIP_HEADERS.has(lh)) {
      result.skipped_headers.push(lh);
      continue;
    }
    const pv = proxyData.headers[h];
    const sv = sub2apiData.headers[h];
    if (pv !== sv) {
      result.header_diffs.push({ header: lh, 'proxy-js': pv || '(missing)', 'sub2api': sv || '(missing)' });
    }
  }

  // --- Body comparison ---
  let proxyBody, sub2apiBody;
  try { proxyBody = JSON.parse(proxyData.body); } catch { proxyBody = proxyData.body; }
  try { sub2apiBody = JSON.parse(sub2apiData.body); } catch { sub2apiBody = sub2apiData.body; }

  if (typeof proxyBody === 'object' && typeof sub2apiBody === 'object') {
    const allDiffs = deepDiff(proxyBody, sub2apiBody);
    for (const d of allDiffs) {
      if (SKIP_BODY_PATHS.has(d.path)) {
        result.skipped_body_paths.push(d.path);
        continue;
      }
      // Check if it's an acceptable known difference
      if (isAcceptableDiff(d)) {
        result.acceptable_diffs.push(d);
      } else {
        result.body_diffs.push(d);
      }
    }
  } else {
    if (proxyBody !== sub2apiBody) {
      result.body_diffs.push({ path: '(raw)', a: proxyBody, b: sub2apiBody });
    }
  }

  // Final verdict
  result.pass = result.header_diffs.length === 0 && result.body_diffs.length === 0;
  return result;
}

function isAcceptableDiff(diff) {
  // Known acceptable differences between the two implementations
  const p = diff.path;

  // Metadata fields with random/instance-specific values
  if (p.startsWith('metadata.')) return true;

  // System prompt may have slight formatting differences
  // (both should strip config section but exact paraphrase text may differ)

  return false;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // Health check
    if (req.method === 'GET' && pathname === '/health') {
      jsonResponse(res, 200, { status: 'ok', captures: Object.keys(captures) });
      return;
    }

    // Reset captures
    if (req.method === 'POST' && pathname === '/reset') {
      resetCaptures();
      jsonResponse(res, 200, { status: 'reset' });
      return;
    }

    // Get captured data
    if (req.method === 'GET' && pathname.startsWith('/captured/')) {
      const source = pathname.split('/')[2];
      if (captures[source]) {
        jsonResponse(res, 200, captures[source]);
      } else {
        jsonResponse(res, 404, { error: `No capture for source: ${source}` });
      }
      return;
    }

    // Compare captures
    if (req.method === 'GET' && pathname === '/compare') {
      jsonResponse(res, 200, compareCaptures());
      return;
    }

    // Capture endpoint — the mock Anthropic API
    if (req.method === 'POST' && (pathname === '/v1/messages' || pathname === '/v1/messages/count_tokens')) {
      const body = await readBody(req);
      const source = detectSource(req);

      // Store capture
      captures[source] = {
        timestamp: new Date().toISOString(),
        method: req.method,
        path: pathname,
        query: url.search,
        headers: { ...req.headers },
        body: body,
      };

      console.log(`[mock] Captured ${source}: ${pathname} (${body.length} bytes)`);

      // Check if streaming requested
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = {}; }

      if (parsed.stream === true) {
        // SSE streaming response
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'x-mock-source': source,
        });

        for (const evt of SSE_EVENTS) {
          res.write(formatSSE(evt.event, evt.data));
        }
        res.end();
      } else {
        // Non-streaming JSON response
        jsonResponse(res, 200, CANNED_RESPONSE, { 'x-mock-source': source });
      }
      return;
    }

    // 404
    jsonResponse(res, 404, { error: 'Not found', path: pathname });

  } catch (err) {
    console.error('[mock] Error:', err);
    jsonResponse(res, 500, { error: err.message });
  }
});

function jsonResponse(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock] Mock Anthropic API listening on 0.0.0.0:${PORT}`);
  console.log(`[mock] Endpoints:`);
  console.log(`[mock]   POST /v1/messages          — Capture & respond`);
  console.log(`[mock]   GET  /captured/:source      — Get captured data`);
  console.log(`[mock]   POST /reset                 — Clear captures`);
  console.log(`[mock]   GET  /compare               — Compare captures`);
  console.log(`[mock]   GET  /health                — Health check`);
});
