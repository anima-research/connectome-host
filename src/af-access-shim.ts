/**
 * TEMPORARY SHIM — REMOVE once @animalabs/agent-framework ships MCPL RFC-015
 * (its `McplServerConfig.accessToken` and `toolHints`, and its exported
 * `AccessRefusedError`). Then import `AccessRefusedError` and the request and
 * result types from '@animalabs/agent-framework' where this file is imported,
 * and delete this file.
 *
 * The shapes below are agent-framework's interface as fixed for its RFC-015
 * work (branch feat/mcpl-toolsets-host). Types only, except the error class:
 * agent-framework maps a refusal to `-32040` by recognizing its own class, so
 * at runtime this exports agent-framework's `AccessRefusedError` whenever the
 * installed version has one, and a local stand-in of the same shape only
 * while it has none (when nothing calls `accessToken` anyway).
 */
import * as agentFramework from '@animalabs/agent-framework';

/** What a server granted `access.token` asks for (RFC-015 §3.1), as
 *  agent-framework hands it to the host once it has checked the grant and the
 *  parameters: `fresh`, `schemes` and `timeoutMs` with their defaults filled. */
export interface AccessTokenRequest {
  serverId: string;
  audience: string;
  endpoint?: string;
  purpose?: string;
  fresh: boolean;
  schemes: string[];
  timeoutMs: number;
}

/** The host's answer (RFC-015 §3.2). `expiresAt` is RFC 3339 in UTC, `Z`. */
export interface AccessTokenResult {
  scheme: string;
  credential: string;
  expiresAt: string;
  principal?: string;
}

/** `McplServerConfig.accessToken`. */
export type AccessTokenProvider = (req: AccessTokenRequest) => Promise<AccessTokenResult>;

/** RFC-015 §3.3's refusal kinds; the set is open. */
export type AccessRefusedKind = 'no_identity' | 'host_policy' | 'provider_refused' | 'rate_limited' | 'unavailable';

/** A refusal agent-framework answers as `-32040`, `{audience, kind, reason}`. */
export interface AccessRefusal extends Error {
  readonly kind: string;
  readonly reason: string;
}

type AccessRefusedErrorClass = new (kind: AccessRefusedKind | string, reason: string) => AccessRefusal;

/** The stand-in, while the installed agent-framework exports none. */
class LocalAccessRefusedError extends Error implements AccessRefusal {
  constructor(readonly kind: AccessRefusedKind | string, readonly reason: string) {
    super(reason);
    this.name = 'AccessRefusedError';
  }
}

const exported = (agentFramework as unknown as Record<string, unknown>).AccessRefusedError;

export const AccessRefusedError: AccessRefusedErrorClass =
  typeof exported === 'function' ? (exported as AccessRefusedErrorClass) : LocalAccessRefusedError;

/** Whether `err` is a refusal, whichever class made it. */
export function isAccessRefusal(err: unknown): err is AccessRefusal {
  return err instanceof AccessRefusedError || err instanceof LocalAccessRefusedError;
}
