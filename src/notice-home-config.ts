/** Operator-owned routing, never populated from model output or inbound traffic. */
export interface NoticeHomeConfig {
  connector: 'zulip';
  logicalAgent: string;
  serverId: string;
  toolPrefix: string;
  declaredRealm: string;
  stream: string;
  statusTopic: string;
  incidentsTopic: string;
  trustMode: 'operator-attested-unverified';
  selfEchoPreflight: 'operator-attested';
}

export function validateNoticeHome(value: unknown): asserts value is NoticeHomeConfig {
  const path = 'modules.notices.home';
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  const v = value as Record<string, unknown>;
  const fields = ['connector', 'logicalAgent', 'serverId', 'toolPrefix', 'declaredRealm', 'stream',
    'statusTopic', 'incidentsTopic', 'trustMode', 'selfEchoPreflight'];
  for (const key of Object.keys(v)) if (!fields.includes(key)) throw new Error(`${path} has unknown field ${key}`);
  for (const key of fields) {
    const s = v[key];
    if (typeof s !== 'string' || !s.trim() || s !== s.trim() || s.length > 256 || /[\x00-\x1f\x7f]/.test(s)) {
      throw new Error(`${path}.${key} must be a trimmed, non-empty string (max 256, no control characters)`);
    }
  }
  if (v.connector !== 'zulip') throw new Error(`${path}.connector must be zulip`);
  if (v.trustMode !== 'operator-attested-unverified') throw new Error(`${path}.trustMode must explicitly be operator-attested-unverified`);
  if (v.selfEchoPreflight !== 'operator-attested') throw new Error(`${path}.selfEchoPreflight must explicitly be operator-attested`);
  if (!/^[a-zA-Z0-9_-]+$/.test(v.serverId as string) || !/^[a-zA-Z0-9_-]+$/.test(v.toolPrefix as string)) {
    throw new Error(`${path} serverId/toolPrefix must be literal identifiers, not patterns`);
  }
  let url: URL;
  try { url = new URL(v.declaredRealm as string); } catch { throw new Error(`${path}.declaredRealm must be an HTTPS origin`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      url.origin !== v.declaredRealm) throw new Error(`${path}.declaredRealm must be a canonical HTTPS origin without credentials/path/trailing slash`);
  if (v.statusTopic === v.incidentsTopic) throw new Error(`${path} requires distinct explicit statusTopic and incidentsTopic`);
}

/** Canonical equality also catches destination/attestation drift on restart. */
export function homeBindingKey(c: NoticeHomeConfig): string {
  return JSON.stringify([c.connector, c.logicalAgent, c.serverId, c.toolPrefix, c.declaredRealm,
    c.stream, c.statusTopic, c.incidentsTopic, c.trustMode, c.selfEchoPreflight]);
}
