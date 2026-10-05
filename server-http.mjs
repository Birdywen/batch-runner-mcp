#!/usr/bin/env node
// Stateless JSON-RPC-over-HTTP front for the forge MCP bridge (私用).
//   POST /mcp     {jsonrpc,id,method,params} -> JSON-RPC response (202 empty for notifications)
//   GET  /healthz {"ok":true} (no auth, for uptime checks)
// Auth: Authorization: Bearer $FORGE_TOKEN (timing-safe compare).
// Refuses to start without FORGE_TOKEN. Zero npm dependencies, like server.mjs.
// No sessions, no SSE: every request is self-contained; batch/flow job maps
// live in the shared module state so status polling works across requests.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { handleRequest } from './server.mjs';

const TOKEN = process.env.FORGE_TOKEN;
if (!TOKEN) {
  console.error('server-http: FORGE_TOKEN is required');
  process.exit(1);
}
const PORT = Number(process.env.FORGE_PORT || 8471);
const MAX_BODY = 1 << 20; // 1MB

function authed(req) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.method !== 'POST' || (req.url !== '/mcp' && req.url !== '/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    if (!authed(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      return;
    }
    const out = await handleRequest(body);
    if (out === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(e.message) } }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`forge-http listening on 127.0.0.1:${PORT}`);
});
