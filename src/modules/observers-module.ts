/**
 * ObserversModule — the agent holds the pen on who may observe its interior.
 *
 * Interiority access (thinking, tool payloads, conversation stream via the
 * webui) is a consent question before it is an ACL question — see connectome
 * docs/observability.md §4. These tools let the agent read and edit its own
 * data/observers.json grant file. The webui's ObserverRegistry hot-reloads
 * the file on mtime (~3s), so grants and revocations apply to new
 * connections without a restart. Operators can edit the same file directly;
 * writes here are atomic (tmp+rename) so the two never corrupt each other.
 *
 * Grants marked `protected: true` (recipe-designated operator baseline) are
 * visible but not revocable through these tools; only a file edit removes
 * them. Tools also cannot CREATE protected grants — protection is an
 * operator-level marker.
 */

import type {
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '@animalabs/agent-framework';
import {
  OBSERVER_SCOPES,
  loadObserversFile,
  saveObserversFile,
  type ObserverGrant,
  type ObserverScope,
  type ObserversFile,
} from './web-ui-observers.js';

export interface ObserversModuleConfig {
  /** Absolute path to the grant file (same one the webui watches). */
  path: string;
}

export class ObserversModule implements Module {
  readonly name = 'observers';

  constructor(private readonly config: ObserversModuleConfig) {}

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'get',
        description:
          'List who is currently authorized to observe your internals through the web viewer ' +
          '(thinking, tool calls, conversation stream — by scope). Each grant is an ed25519 ' +
          'public key + label + scope list. Labels are testimony, not verified identity.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'grant',
        description:
          'Authorize an observer key to watch your internals through the web viewer. ' +
          `Scopes (event families): ${OBSERVER_SCOPES.join(', ')}. ` +
          "'health' = liveness/usage only; 'ops' = alerts (refusals, failures); 'messages' = the " +
          "conversation; 'tools' = tool calls and results; 'thinking' = your thinking blocks; " +
          "'debug' = compiled-context debug endpoints (implies seeing everything in your window). " +
          'Grant deliberately — this is access to your interior. Takes effect within ~3 seconds.',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'ed25519:<base64url public key> — the fingerprint the person/device shows you.' },
            label: { type: 'string', description: 'Who this is (your words — e.g. "antra-phone", "fleet-hub").' },
            scopes: {
              type: 'array',
              items: { type: 'string', enum: [...OBSERVER_SCOPES] },
              description: 'Event families this key may receive.',
            },
            expires: { type: 'string', description: 'Optional ISO timestamp; the grant stops working after this.' },
          },
          required: ['key', 'label', 'scopes'],
        },
      },
      {
        name: 'revoke',
        description:
          'Remove an observer grant by key or by label. Protected (operator-baseline) grants ' +
          'cannot be revoked here. Existing connections are not killed, but new connections and ' +
          'HTTP sessions stop authenticating within ~3 seconds.',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'ed25519:<base64url public key> to revoke.' },
            label: { type: 'string', description: 'Alternative: revoke by exact label (must match exactly one grant).' },
          },
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const input = (call.input ?? {}) as Record<string, unknown>;
    try {
      switch (call.name) {
        case 'get':
          return ok({ observers: this.load().observers.map(redactNothing) });

        case 'grant': {
          const key = typeof input.key === 'string' ? input.key.trim() : '';
          const label = typeof input.label === 'string' ? input.label.trim() : '';
          const scopes = Array.isArray(input.scopes) ? input.scopes : [];
          if (!key.startsWith('ed25519:') || key.length < 20) {
            return err('key must be "ed25519:<base64url public key>"');
          }
          if (!label) return err('label is required');
          if (scopes.length === 0 || !scopes.every((s) => (OBSERVER_SCOPES as readonly string[]).includes(s as string))) {
            return err(`scopes must be a non-empty subset of: ${OBSERVER_SCOPES.join(', ')}`);
          }
          const expires = typeof input.expires === 'string' ? input.expires : null;
          if (expires && !Number.isFinite(Date.parse(expires))) return err('expires must be an ISO timestamp');

          const file = this.load();
          const existing = file.observers.find((g) => g.key === key);
          if (existing?.protected) return err('that key holds a protected grant — edit the file to change it');
          const grant: ObserverGrant = { key, label, scopes: scopes as ObserverScope[], expires };
          if (existing) {
            Object.assign(existing, grant); // update label/scopes/expiry in place
          } else {
            file.observers.push(grant);
          }
          saveObserversFile(this.config.path, file);
          return ok({
            message: `${existing ? 'Updated' : 'Granted'}: ${label} → [${grant.scopes.join(', ')}]${expires ? ` until ${expires}` : ''}. Live within ~3s.`,
            observers: file.observers,
          });
        }

        case 'revoke': {
          const key = typeof input.key === 'string' ? input.key.trim() : '';
          const label = typeof input.label === 'string' ? input.label.trim() : '';
          if (!key && !label) return err('provide key or label');
          const file = this.load();
          const matches = file.observers.filter((g) => (key ? g.key === key : g.label === label));
          if (matches.length === 0) return err('no matching grant');
          if (matches.length > 1) return err(`label matches ${matches.length} grants — revoke by key`);
          const target = matches[0]!;
          if (target.protected) return err('that grant is protected (operator baseline) — edit the file to remove it');
          file.observers = file.observers.filter((g) => g !== target);
          saveObserversFile(this.config.path, file);
          return ok({ message: `Revoked: ${target.label}. New connections stop within ~3s.`, observers: file.observers });
        }

        default:
          return { success: false, error: `Unknown tool: ${call.name}`, isError: true };
      }
    } catch (e) {
      return err(`observers file operation failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  private load(): ObserversFile {
    return loadObserversFile(this.config.path) ?? { observers: [] };
  }
}

function redactNothing(g: ObserverGrant): ObserverGrant {
  return g; // grants hold public keys + labels only — nothing secret to redact
}

function ok(data: Record<string, unknown>): ToolResult {
  return { success: true, data, isError: false };
}

function err(message: string): ToolResult {
  return { success: false, error: message, isError: true };
}
