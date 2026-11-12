/**
 * Remote MCP endpoint.
 *
 * A model authenticates with the same sync passphrase used on other devices.
 * The passphrase is stretched exactly like the client does; the resulting
 * authentication key must match an existing sync space. The derived encryption
 * key is then used to read and write the encrypted change log over MCP.
 */

import type { NextFunction, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { findUser, type UserRow } from '../db.js';
import { authKeyHash, keysFor, type SyncKeys } from './crypto.js';
import { registerTaskerTools } from './tools.js';

export const MCP_ENABLED = process.env.MCP_ENABLED !== 'false' && process.env.MCP_ENABLED !== '0';

interface McpRequest extends Request {
  taskerMcp?: { user: UserRow; keys: SyncKeys };
}

const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string, limit: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > limit;
}

async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Browser/MCP clients normally use the Authorization header. The dedicated
  // header exists because some passphrases contain characters a bearer parser
  // may disagree with.
  const header = req.headers.authorization ?? '';
  const custom = req.headers['x-tasker-passphrase'];
  const passphrase =
    (header.startsWith('Bearer ') ? header.slice(7).trim() : '') ||
    (Array.isArray(custom) ? custom[0] : custom ?? '').trim();

  if (passphrase.length < 8) {
    res.status(401).json({ error: 'missing_passphrase' });
    return;
  }

  // PBKDF2 is intentionally expensive, so cap total derivations per minute.
  if (rateLimited('derive', 60)) {
    res.status(429).json({ error: 'slow_down' });
    return;
  }

  try {
    const keys = await keysFor(passphrase);
    const keyHash = authKeyHash(keys.authKey);
    const user = findUser(keyHash);
    if (!user) {
      res.status(401).json({ error: 'unknown_sync_space' });
      return;
    }
    if (rateLimited(keyHash, 180)) {
      res.status(429).json({ error: 'slow_down' });
      return;
    }
    (req as McpRequest).taskerMcp = { user, keys };
    next();
  } catch {
    res.status(500).json({ error: 'key_derivation_failed' });
  }
}

/** Express-friendly wrapper so async auth failures cannot crash the process. */
export function mcpAuth(req: Request, res: Response, next: NextFunction): void {
  void authenticate(req, res, next).catch(() => {
    if (!res.headersSent) res.status(500).json({ error: 'mcp_auth_failed' });
  });
}

export async function handleMcp(req: Request, res: Response): Promise<void> {
  const auth = (req as McpRequest).taskerMcp;
  if (!auth) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const server = new McpServer({ name: 'tasker', version: '1.0.0' });
  registerTaskerTools(server, auth);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

/** Stateless Streamable HTTP does not expose a standalone SSE stream. */
export function mcpMethodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
}
