#!/usr/bin/env node
/**
 * Billing Proxy Comparison Test Orchestrator
 *
 * Sends identical requests to proxy.js and Sub2API, then compares what the
 * mock server captured from each. Zero dependencies.
 *
 * Environment variables:
 *   PROXY_JS_URL   - proxy.js base URL       (default: http://localhost:18801)
 *   SUB2API_URL    - Sub2API base URL         (default: http://localhost:8080)
 *   MOCK_URL       - Mock server base URL     (default: http://localhost:9999)
 *   SUB2API_API_KEY - API key for Sub2API     (default: test-billing-key)
 *   ADMIN_URL      - Sub2API admin API URL    (default: http://localhost:8080)
 *   ADMIN_EMAIL    - Sub2API admin email      (default: admin@test.local)
 *   ADMIN_PASSWORD - Sub2API admin password   (default: testpassword123)
 *   SUB2API_BILLING_TOKEN - Upstream token used by native billing_proxy
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────
const PROXY_JS_URL = process.env.PROXY_JS_URL || 'http://localhost:18801';
const SUB2API_URL = process.env.SUB2API_URL || 'http://localhost:8080';
const MOCK_URL = process.env.MOCK_URL || 'http://localhost:9999';
const SUB2API_API_KEY = process.env.SUB2API_API_KEY || 'test-billing-key';
const ADMIN_URL = process.env.ADMIN_URL || SUB2API_URL;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@test.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'testpassword123';
const SUB2API_BILLING_TOKEN = process.env.SUB2API_BILLING_TOKEN || 'sk-ant-sub2api-test-token';

const MAX_RETRIES = 60;
const RETRY_INTERVAL = 2000;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function httpRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const headers = { ...(options.headers || {}) };
    if (options.body && !hasHeader(headers, 'content-length')) {
      headers['content-length'] = Buffer.byteLength(options.body);
    }
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers,
    };

    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// Consume SSE stream fully — we don't need the response content,
// just need the request to complete so the mock server captures it.
function httpRequestStream(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const headers = { ...(options.headers || {}) };
    if (options.body && !hasHeader(headers, 'content-length')) {
      headers['content-length'] = Buffer.byteLength(options.body);
    }
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers,
    };

    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ─── Wait for service health ──────────────────────────────────────────────────
async function waitForService(name, url, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await httpRequest(url);
      if (res.status === 200) {
        console.log(`  [OK] ${name} is ready`);
        return true;
      }
    } catch {
      // not ready yet
    }
    if (i < retries - 1) {
      process.stdout.write(`  [..] Waiting for ${name} (${i + 1}/${retries})...\r`);
      await sleep(RETRY_INTERVAL);
    }
  }
  console.error(`  [FAIL] ${name} did not become ready after ${retries} attempts`);
  return false;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function hasHeader(headers, name) {
  const target = name.toLowerCase();
  return Object.keys(headers).some(k => k.toLowerCase() === target);
}

function parseJSONBody(res, label) {
  try {
    return JSON.parse(res.body);
  } catch (err) {
    throw new Error(`${label} returned invalid JSON (${res.status}): ${res.body.slice(0, 200)}`);
  }
}

function getResponseData(data) {
  return data?.data || data;
}

function getItems(data) {
  const payload = getResponseData(data);
  return payload?.items || payload || [];
}

function authHeaders(token, extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    ...extra,
  };
}

function summarizeBody(body, limit = 300) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 3) + '...' : text;
}

async function loginAdmin() {
  const res = await httpRequest(`${ADMIN_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    }),
  });

  const data = parseJSONBody(res, 'admin login');
  if (res.status !== 200) {
    throw new Error(`admin login failed (${res.status}): ${res.body}`);
  }

  const payload = getResponseData(data);
  const token = payload?.access_token || data?.access_token;
  if (!token) {
    throw new Error(`admin login did not return access_token: ${res.body}`);
  }

  console.log(`  [OK] Logged in as admin: ${ADMIN_EMAIL}`);
  return token;
}

// ─── Sub2API Initialization ───────────────────────────────────────────────────
// Create a billing_proxy account and an API key that routes through it.
async function initSub2API() {
  console.log('\n--- Sub2API Initialization ---');
  const adminToken = await loginAdmin();

  // Step 1: Create a group for billing_proxy accounts
  let groupId;
  try {
    const groupRes = await httpRequest(`${ADMIN_URL}/api/v1/admin/groups`, {
      method: 'POST',
      headers: authHeaders(adminToken, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        name: 'test-billing-group',
        platform: 'anthropic',
        rate_multiplier: 1,
        subscription_type: 'standard',
      }),
    });
    const groupData = parseJSONBody(groupRes, 'group create');
    if (groupRes.status === 200 || groupRes.status === 201) {
      groupId = groupData.data?.id || groupData.id;
      console.log(`  [OK] Created group: ${groupId}`);
    } else {
      // Group might already exist, try to list and find it
      console.log(`  [..] Group creation returned ${groupRes.status}, trying to find existing...`);
      const listRes = await httpRequest(`${ADMIN_URL}/api/v1/admin/groups`, {
        headers: authHeaders(adminToken),
      });
      const listData = parseJSONBody(listRes, 'group list');
      const groups = getItems(listData);
      const existing = groups.find(g => g.name === 'test-billing-group');
      if (existing) {
        groupId = existing.id;
        console.log(`  [OK] Found existing group: ${groupId}`);
      } else {
        throw new Error(`Cannot find or create test-billing-group; create response ${groupRes.status}: ${groupRes.body}`);
      }
    }
  } catch (e) {
    console.error(`  [FAIL] Group setup failed: ${e.message}`);
    throw e;
  }

  // Step 2: Create a billing_proxy account
  let accountId;
  try {
    const accountRes = await httpRequest(`${ADMIN_URL}/api/v1/admin/accounts`, {
      method: 'POST',
      headers: authHeaders(adminToken, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        name: 'test-billing-proxy',
        platform: 'anthropic',
        type: 'billing_proxy',
        credentials: {
          access_token: SUB2API_BILLING_TOKEN,
        },
        extra: {
          strip_system_config: true,
          strip_tool_descriptions: true,
          inject_cc_stubs: true,
          strip_trailing_assistant_prefill: true,
        },
        group_ids: [groupId],
        concurrency: 10,
        priority: 1,
      }),
    });
    const accountData = parseJSONBody(accountRes, 'account create');
    if (accountRes.status === 200 || accountRes.status === 201) {
      accountId = accountData.data?.id || accountData.id;
      console.log(`  [OK] Created billing_proxy account: ${accountId}`);
    } else {
      console.error(`  [WARN] Account creation returned ${accountRes.status}: ${accountRes.body}`);
      // Try to find existing
      const listRes = await httpRequest(`${ADMIN_URL}/api/v1/admin/accounts?type=billing_proxy`, {
        headers: authHeaders(adminToken),
      });
      const listData = parseJSONBody(listRes, 'account list');
      const accounts = getItems(listData);
      const existing = accounts.find(a => a.name === 'test-billing-proxy');
      if (existing) {
        accountId = existing.id;
        console.log(`  [OK] Using existing account: ${accountId}`);
      } else {
        throw new Error('Cannot create or find test-billing-proxy account');
      }
    }
  } catch (e) {
    console.error(`  [FAIL] Account setup failed: ${e.message}`);
    throw e;
  }

  // Step 3: Create or find an API key that will be used for gateway requests
  try {
    // Check if there's already an API key we can use
    const keysRes = await httpRequest(`${ADMIN_URL}/api/v1/keys`, {
      headers: authHeaders(adminToken),
    });

    if (keysRes.status === 200) {
      const keysData = parseJSONBody(keysRes, 'api key list');
      const keys = getItems(keysData);
      const existing = keys.find(k => k.name === 'test-billing-key');
      if (existing) {
        console.log(`  [OK] Found existing API key`);
        return { accountId, groupId, apiKey: existing.key || SUB2API_API_KEY };
      }
    }

    // Create a new API key
    const keyRes = await httpRequest(`${ADMIN_URL}/api/v1/keys`, {
      method: 'POST',
      headers: authHeaders(adminToken, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        name: 'test-billing-key',
        group_id: groupId,
        custom_key: SUB2API_API_KEY,
      }),
    });

    if (keyRes.status === 200 || keyRes.status === 201) {
      const keyData = parseJSONBody(keyRes, 'api key create');
      const apiKey = keyData.data?.key || keyData.key || SUB2API_API_KEY;
      console.log(`  [OK] Created API key`);
      return { accountId, groupId, apiKey };
    }
    throw new Error(`API key creation returned ${keyRes.status}: ${keyRes.body}`);
  } catch (e) {
    console.error(`  [FAIL] API key setup failed: ${e.message}`);
    throw e;
  }
}

// ─── Test Runner ──────────────────────────────────────────────────────────────
async function runPayloadTest(payloadFile, apiKey) {
  const name = path.basename(payloadFile, '.json');
  const payload = JSON.parse(fs.readFileSync(payloadFile, 'utf-8'));
  const isStreaming = payload.stream === true;

  // Remove _test metadata before sending
  const testMeta = payload._test;
  delete payload._test;
  const bodyStr = JSON.stringify(payload);

  console.log(`\n  [${name}] ${testMeta?.description || ''}`);
  console.log(`  [${name}] Streaming: ${isStreaming}, Body: ${bodyStr.length} bytes`);

  // Reset mock captures
  await httpRequest(`${MOCK_URL}/reset`, { method: 'POST' });

  // Send to proxy.js
  try {
    const proxyRes = await httpRequestStream(`${PROXY_JS_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-test-source': 'proxy-js',
      },
      body: bodyStr,
    });
    console.log(`  [${name}] proxy.js response: ${proxyRes.status}`);
    if (proxyRes.status < 200 || proxyRes.status >= 300) {
      console.log(`  [${name}] proxy.js body: ${summarizeBody(proxyRes.body)}`);
    }
  } catch (e) {
    console.error(`  [${name}] proxy.js ERROR: ${e.message}`);
    return { name, status: 'error', error: `proxy.js: ${e.message}` };
  }

  // Small delay to ensure mock server has processed
  await sleep(200);

  // Send to Sub2API
  try {
    const sub2apiRes = await httpRequestStream(`${SUB2API_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
        'x-test-source': 'sub2api',
      },
      body: bodyStr,
    });
    console.log(`  [${name}] sub2api response: ${sub2apiRes.status}`);
    if (sub2apiRes.status < 200 || sub2apiRes.status >= 300) {
      console.log(`  [${name}] sub2api body: ${summarizeBody(sub2apiRes.body)}`);
    }
  } catch (e) {
    console.error(`  [${name}] sub2api ERROR: ${e.message}`);
    return { name, status: 'error', error: `sub2api: ${e.message}` };
  }

  // Small delay
  await sleep(200);

  // Get comparison
  try {
    const compareRes = await httpRequest(`${MOCK_URL}/compare`);
    const result = JSON.parse(compareRes.body);
    result.name = name;
    result.testMeta = testMeta;

    if (result.pass) {
      console.log(`  [${name}] PASS`);
    } else {
      console.log(`  [${name}] FAIL`);
      if (result.message) {
        console.log(`    ${result.message}`);
      }
      if (result.available_sources?.length > 0) {
        console.log(`    Captured sources: ${result.available_sources.join(', ')}`);
      }
      if (result.header_diffs?.length > 0) {
        console.log(`    Header diffs (${result.header_diffs.length}):`);
        for (const d of result.header_diffs) {
          console.log(`      ${d.header}: proxy-js="${d['proxy-js']}" vs sub2api="${d['sub2api']}"`);
        }
      }
      if (result.body_diffs?.length > 0) {
        console.log(`    Body diffs (${result.body_diffs.length}):`);
        for (const d of result.body_diffs) {
          const aStr = typeof d.a === 'string' ? d.a : JSON.stringify(d.a);
          const bStr = typeof d.b === 'string' ? d.b : JSON.stringify(d.b);
          const aShort = aStr.length > 80 ? aStr.slice(0, 77) + '...' : aStr;
          const bShort = bStr.length > 80 ? bStr.slice(0, 77) + '...' : bStr;
          console.log(`      ${d.path}:`);
          console.log(`        proxy-js: ${aShort}`);
          console.log(`        sub2api:  ${bShort}`);
        }
      }
    }

    if (result.acceptable_diffs?.length > 0) {
      console.log(`    Acceptable diffs: ${result.acceptable_diffs.length} (metadata etc.)`);
    }

    return result;
  } catch (e) {
    console.error(`  [${name}] Compare ERROR: ${e.message}`);
    return { name, status: 'error', error: `compare: ${e.message}` };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Billing Proxy Comparison Test ===\n');
  console.log(`  proxy.js:  ${PROXY_JS_URL}`);
  console.log(`  sub2api:   ${SUB2API_URL}`);
  console.log(`  mock:      ${MOCK_URL}`);

  // Wait for all services
  console.log('\n--- Waiting for services ---');
  const services = [
    ['mock-server', `${MOCK_URL}/health`],
    ['proxy.js', `${PROXY_JS_URL}/health`],
    ['sub2api', `${SUB2API_URL}/health`],
  ];

  for (const [name, url] of services) {
    const ready = await waitForService(name, url);
    if (!ready) {
      console.error(`\nAborting: ${name} is not available.`);
      process.exit(1);
    }
  }

  // Initialize Sub2API (create billing_proxy account + API key)
  let apiKey;
  try {
    const init = await initSub2API();
    apiKey = init.apiKey;
  } catch (e) {
    console.error(`\n[FAIL] Sub2API init failed: ${e.message}`);
    process.exit(1);
  }

  // Load test payloads
  const payloadsDir = path.join(__dirname, 'payloads');
  const payloadFiles = fs.readdirSync(payloadsDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => path.join(payloadsDir, f));

  console.log(`\n--- Running ${payloadFiles.length} test payloads ---`);

  const results = [];
  for (const file of payloadFiles) {
    const result = await runPayloadTest(file, apiKey);
    results.push(result);
  }

  // Summary
  console.log('\n\n=== SUMMARY ===\n');
  let passed = 0, failed = 0, errors = 0;
  for (const r of results) {
    const icon = r.status === 'error' ? 'ERR' : r.pass ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${r.name || r.testMeta?.name || 'unknown'}`);
    if (r.pass) passed++;
    else if (r.status === 'error') errors++;
    else failed++;
  }

  console.log(`\n  Total: ${results.length} | Passed: ${passed} | Failed: ${failed} | Errors: ${errors}`);

  if (failed > 0 || errors > 0) {
    console.log('\n  Result: FAIL');
    process.exit(1);
  } else {
    console.log('\n  Result: ALL PASS');
    process.exit(0);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
