import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { maskRunVarying, runVaryingMasker } from './compare.mjs';
import { prose } from './prose.mjs';

// The openings of context-manager's compression instructions (autobiographical.ts, knowledge.ts) and of
// connectome-host's frontdesk strategy (frontdesk-strategy.ts).
export const INSTRUCTIONS = [
  /Write the memory of events since the most recent memory system notification\./,
  /Write the memory of this slice of the log\./,
  /You have just been reading a substantial body of text/,
  /You have just reviewed [\s\S]+? in chronological order\./,
  /You have just re-experienced [\s\S]+? in chronological order\./,
  /Summarize the research performed\./,
  /Capture the reasoning and conclusions from this discussion\./,
  /Record what knowledge was captured\./,
  /Summarize the subagent work\./,
  /Please consolidate these \d+ L\d summaries/,
  /Starting from my last message, please describe everything that has happened\./,
];

function requestedTarget(instruction) {
  const m = instruction.match(/Target ~(\d+) tokens|Aim for about (\d+) tokens/);
  return m ? Number(m[1] ?? m[2]) : null;
}

function requestedLevel(instruction) {
  const merge = instruction.match(/into a single L(\d+) memory|single L(\d+) memory|at L(\d+)\.|consolidate these \d+ L(\d) summaries/);
  if (!merge) return 1;
  const named = merge.slice(1).find((x) => x !== undefined);
  return /consolidate these/.test(merge[0]) ? Number(named) + 1 : Number(named);
}

export const CANARY = /\[\[c:[^\]\s]+\]\]/g;
export const SUMMARY = /\[\[s:M[0-9a-f]{8}\]\]/g;

const canaryOrder = (a, b) => {
  const pa = a.match(/\d+|\D+/g) ?? [];
  const pb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const [x, y] = [pa[i], pb[i]];
    if (x === y) continue;
    if (/^\d/.test(x) && /^\d/.test(y) && BigInt(x) !== BigInt(y)) return BigInt(x) < BigInt(y) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
};

// context-manager estimates prose at 2.9 characters a token and dense text at 2.3 (message-store.ts); these rates
// count about 1.3 times its estimate, so its calibration has a gap to close.
const RATE = { prose: 2.2, code: 1.9, json: 1.65, base64: 1.35, signature: 3.3 };
const MESSAGE_OVERHEAD = 4;
// The provider's prompt-cache lifetimes, 5 minutes or 1 hour, and its lookback: "The lookback window is 20 blocks.
// The system checks at most 20 positions for each breakpoint, counting the breakpoint itself as the first", where "a
// run of consecutive `tool_use` blocks counts as one position, and so does a run of consecutive `tool_result` blocks"
// ("How automatic prefix checking works", https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
const LOOKBACK_POSITIONS = 20;
const FIVE_MINUTES = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;
// The provider's minimum cacheable prompt length, by model: a shorter prefix isn't cached, even marked
// ("Cache limitations", https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
const CACHE_MINIMUM = { 'claude-opus-4-6': 4096, 'claude-opus-5-5': 512 };
// The same page's "What invalidates the cache" also keys the messages cache on `tool_choice` and
// `output_config.effort`, and the system and messages caches on `speed`.
const UNMODELLED = ['tool_choice', 'speed', 'output_config'];

const sha = (s) => createHash('sha256').update(s).digest('hex');
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);

function kindOf(text) {
  if (/^[\s]*[{[]/.test(text)) { try { JSON.parse(text); return 'json'; } catch {} }
  if (text.length > 64 && /^[A-Za-z0-9+/=\s]+$/.test(text) && !/ [a-z]+ /.test(text)) return 'base64';
  return denseKind(text);
}

const DENSE = /[{}[\]":_/=;()<>`]/g;
const denseKind = (text) => (text.length && (text.match(DENSE) || []).length / text.length > 0.12 ? 'code' : 'prose');

const SEGMENT = 2000;
function textTokens(text) {
  if (!text) return 0;
  const whole = kindOf(text);
  if (whole === 'json' || whole === 'base64' || text.length <= SEGMENT) return Math.ceil(text.length / RATE[whole]);
  let chars = 0;
  for (let at = 0; at < text.length; at += SEGMENT) {
    const part = text.slice(at, at + SEGMENT);
    chars += part.length / RATE[denseKind(part)];
  }
  return Math.ceil(chars);
}

export function pngSize(data) {
  try {
    const b = Buffer.from(data.slice(0, 64), 'base64');
    if (b.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch { return null; }
}

function blockTokens(block) {
  if (typeof block === 'string') return textTokens(block);
  if (!block || typeof block !== 'object') return 0;
  switch (block.type) {
    case 'text': return textTokens(block.text);
    case 'thinking': return textTokens(block.thinking) + Math.ceil((block.signature || '').length / RATE.signature);
    case 'redacted_thinking': return Math.ceil((block.data || '').length / RATE.signature);
    case 'tool_use': return textTokens(block.name || '') + Math.ceil(JSON.stringify(block.input ?? {}).length / RATE.json);
    case 'tool_result': return Array.isArray(block.content) ? block.content.reduce((t, b) => t + blockTokens(b), 0) : textTokens(String(block.content ?? ''));
    case 'image': {
      const size = block.source?.type === 'base64' ? pngSize(block.source.data || '') : null;
      return size ? Math.ceil((size.width * size.height) / 750) : 1600;
    }
    default: return Math.ceil(JSON.stringify(block).length / RATE.json);
  }
}

function fitToMaxTokens(content, maxTokens) {
  let used = 0;
  const out = [];
  for (const b of content) {
    const t = blockTokens(b);
    if (used + t <= maxTokens) { out.push(b); used += t; continue; }
    if (b.type === 'text') {
      const room = maxTokens - used;
      let kept = b.text.slice(0, Math.max(0, Math.floor(room * RATE[kindOf(b.text)])));
      while (kept && textTokens(kept) > room) kept = kept.slice(0, Math.floor(kept.length * 0.99));
      if (kept) out.push({ ...b, text: kept });
    }
    return { content: out, cut: true };
  }
  return { content: out, cut: false };
}

const unmarked = (v) => {
  if (Array.isArray(v)) return v.map(unmarked);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'cache_control').map(([k, x]) => [k, k === 'input' ? x : unmarked(x)]));
};
const blocksOf = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);
const holdsImage = (blocks) => blocks.some((b) => b?.type === 'image' || (b?.type === 'tool_result' && holdsImage(blocksOf(b.content))));

// The provider caches a request's prefix in the order it reads it: tools, then system, then messages.
function elements(body) {
  const out = [];
  let h = sha(String(body.model));
  const push = (value, tokens, marker, run = null) => {
    h = sha(h + JSON.stringify(unmarked(value)));
    const last = out.at(-1);
    out.push({ hash: h, tokens, marker, position: !last ? 0 : run && last.run === run ? last.position : last.position + 1, run });
  };
  for (const tool of body.tools || []) push({ tool }, Math.ceil(JSON.stringify(unmarked(tool)).length / RATE.json), tool.cache_control);
  for (const block of typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : body.system || []) push({ system: block }, blockTokens(block), block.cache_control);
  // Changing the thinking configuration (its mode and budget_tokens), or adding or removing images anywhere in the
  // prompt, invalidates the messages cache; the page names no model that renders thinking ahead of tools and system
  // ("What invalidates the cache", and "Thinking and prompt caching" at
  // https://platform.claude.com/docs/en/build-with-claude/thinking).
  const images = (body.messages || []).some((m) => holdsImage(blocksOf(m.content)));
  h = sha(h + JSON.stringify([body.thinking?.type ?? null, body.thinking?.budget_tokens ?? null, images]));
  for (const [i, m] of (body.messages || []).entries()) {
    const blocks = blocksOf(m.content);
    blocks.forEach((block, j) => push({ message: i, role: m.role, block }, blockTokens(block) + (j === 0 ? MESSAGE_OVERHEAD : 0), block.cache_control, ['tool_use', 'tool_result'].includes(block.type) ? block.type : null));
  }
  if (body.cache_control && out.length) out.at(-1).marker = out.at(-1).marker ?? body.cache_control;
  return out;
}

export function countTokens(body) {
  return elements(body).reduce((t, e) => t + e.tokens, 0);
}

function texts(body) {
  const out = [];
  const walk = (b) => {
    if (typeof b === 'string') { out.push(b); return; }
    if (!b || typeof b !== 'object') return;
    if (b.type === 'text') out.push(b.text || '');
    if (b.type === 'tool_result') blocksOf(b.content).forEach(walk);
  };
  for (const m of body.messages || []) blocksOf(m.content).forEach(walk);
  return out;
}

const found = (strings, re) => strings.flatMap((s) => s.match(re) || []);

// A signed thinking block binds to everything ahead of its message: system, tools, model, the rest of the head, and
// the messages before it, cache markers aside.
function bindingIdentity(body, beforeMessage) {
  const head = Object.fromEntries(Object.entries(body).filter(([k]) => !['messages', 'stream', 'metadata', 'system', 'tools', 'model'].includes(k)));
  return sha(JSON.stringify(sorted(unmarked({ model: body.model, system: body.system ?? null, tools: body.tools ?? null, head, messages: (body.messages || []).slice(0, beforeMessage) }))));
}

const THINKING_CHARS = 600;

// A signature is as long as one digest: its first 22 characters bind the thinking to the request ahead of it, and the
// last 21 are the thinking's own, which the extended-thinking page says the provider verifies on every model.
const digest64 = (text) => Buffer.from(sha(text), 'hex').toString('base64url');
const signatureFor = (identity, thinking) => `fx1.${digest64(`${identity}\n${thinking}`).slice(0, 22)}${digest64(thinking).slice(0, 21)}`;
const signs = (signature, thinking) => typeof signature === 'string' && signature.startsWith('fx1.') && signature.slice(4 + 22) === digest64(thinking).slice(0, 21);

const systemText = (body) => (typeof body.system === 'string' ? body.system : (body.system || []).map((b) => b.text || '').join(''));

function readSummariser(body, target) {
  const all = [systemText(body), ...texts(body)];
  return {
    target,
    canaries: [...new Set(found(all, CANARY))].sort(canaryOrder),
    recalled: [...new Set(found(all, SUMMARY))].sort(),
  };
}

export const markerOf = (cc) => (cc && typeof cc === 'object' && cc.type === 'ephemeral' && Object.keys(cc).every((k) => k === 'type' || k === 'ttl') && [undefined, '5m', '1h'].includes(cc.ttl) ? cc.ttl ?? '5m' : JSON.stringify(sorted(cc)));

const headerValues = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);

// What a request's tool pairs went through, by the marks the repairs write, at the stack's locked versions:
// membrane 0.8.0's normalizer textifies a result with no call before it or a second one for a call, and answers a
// call left without one with `[pending]` (normalize-tool-pairs.ts:546, :641, :968); context-manager 0.24.0's
// pairing repair leaves `[tool call omitted]` for blocks it drops, a moved result's note and a stub for a call whose
// result it hasn't (autobiographical.ts:19390, :19500, :19319; normalize-tool-messages.ts:133).
export function repairMarks(type, text) {
  const out = [];
  for (const m of text.matchAll(/\[(orphan|duplicate) tool_result for [^\]\n]*\]/g)) out.push(`membrane:${m[1]}`);
  if (type === 'tool_result' && text === '[pending]') out.push('membrane:pending');
  for (const m of text.matchAll(/\[tool call omitted\]|\[tool result moved during context repair\]/g)) out.push(m[0] === '[tool call omitted]' ? 'context-manager:omitted' : 'context-manager:moved');
  if (type === 'tool_result' && text.startsWith('[this call\'s result isn\'t shown in this context.')) out.push('context-manager:stub');
  return out;
}

function normalise(body, headers, mask) {
  const block = (b) => {
    const text = b.type === 'text' ? b.text || '' : b.type === 'tool_result' ? texts({ messages: [{ content: [b] }] }).join('') : '';
    const out = { type: b.type, chars: b.type === 'text' || b.type === 'tool_result' ? text.length : b.type === 'thinking' ? (b.thinking || '').length : b.type === 'tool_use' ? JSON.stringify(b.input ?? {}).length : b.type === 'image' ? (b.source?.data || '').length : JSON.stringify(b).length };
    const canaries = text.match(CANARY); if (canaries) out.canaries = canaries;
    const summaries = text.match(SUMMARY); if (summaries) out.summaries = summaries;
    // agent-framework's placeholder for an image it no longer sends: `[image: image/png, ~691KB, ref img_k7x3q2_7]`.
    const placeholders = text.match(/\[image: [^\]]*\]/g); if (placeholders) out.placeholders = placeholders.length;
    const repairs = repairMarks(b.type, text); if (repairs.length) out.repairs = repairs;
    if (b.type === 'tool_use') out.toolUseId = b.id;
    if (b.type === 'tool_result') {
      out.toolUseId = b.tool_use_id;
      const images = blocksOf(b.content).filter((x) => x?.type === 'image').length;
      if (images) out.images = images;
      const inner = blocksOf(b.content).map((x) => (x?.cache_control != null ? markerOf(x.cache_control) : null));
      if (inner.some(Boolean)) out.contentCache = inner;
    }
    if (b.cache_control != null) out.cache = markerOf(b.cache_control);
    if (b.type === 'thinking') out.signature = b.signature ?? null;
    return out;
  };
  const system = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map((b) => b.text || '').join('') : '';
  const digest = (v) => sha(JSON.stringify(sorted(mask(v ?? null)))).slice(0, 16);
  const { messages: _m, model: _o, max_tokens: _x, stream: _s, thinking: _t, tool_choice: _c, system: _y, tools: _l, ...rest } = body;
  const systemBlocks = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : Array.isArray(body.system) ? body.system : [];
  return {
    head: {
      model: body.model ?? null,
      maxTokens: body.max_tokens ?? null,
      toolChoice: body.tool_choice ?? null,
      thinking: body.thinking ?? null,
      system: systemBlocks.map(({ type, text, cache_control: cc, ...rest }) => {
        const other = { ...(type !== 'text' ? { type: type ?? null } : {}), ...rest };
        return { text: mask(text ?? ''), cache: cc === undefined ? null : cc === null ? 'null' : markerOf(cc), ...(Object.keys(other).length ? { other: digest(other) } : {}) };
      }),
      tools: (body.tools || []).map((t) => ({ name: t.name, sha: digest(t) })),
      rest: Object.keys(rest).length ? digest(rest) : null,
      headers: { beta: [...new Set(headerValues(headers['anthropic-beta']))].sort(), version: headers['anthropic-version'] ?? null },
    },
    model: body.model ?? null,
    maxTokens: body.max_tokens ?? null,
    stream: body.stream === true,
    thinking: body.thinking ?? null,
    system: { sha256: sha(system), chars: system.length },
    tools: (body.tools || []).map((t) => t.name),
    messages: (body.messages || []).map((m) => ({ role: m.role, digest: digestOf(m, mask), blocks: blocksOf(m.content).map(block) })),
  };
}

const withoutKept = (x) => {
  if (!x || typeof x !== 'object' || Array.isArray(x) || x.cache_control == null) return x;
  const { cache_control: _c, ...rest } = x;
  return rest;
};
const withoutRecordedMarkers = (blocks) => blocks.map((b) => {
  const rest = withoutKept(b);
  return rest?.type === 'tool_result' && Array.isArray(rest.content) ? { ...rest, content: rest.content.map(withoutKept) } : rest;
});
const digestOf = ({ role, content, ...envelope }, mask) => sha(JSON.stringify(mask({ role, content: withoutRecordedMarkers(blocksOf(content)), ...sorted(envelope) }))).slice(0, 16);

export function tokensSent(records) {
  const sum = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const { usage } of records) {
    if (!usage) continue;
    sum.input += usage.input_tokens;
    sum.cacheRead += usage.cache_read_input_tokens;
    sum.cacheWrite += usage.cache_creation_input_tokens;
    sum.output += usage.output_tokens;
  }
  return sum;
}

const summariserTexts = (body, mask) => (body.messages || []).flatMap((m) => blocksOf(m.content).filter((b) => b.type === 'text' && !(b.text || '').match(CANARY)).map((b) => mask(b.text || '')));

export async function startStandin({ configuration, rawDir = null, refuseMerges = false, rejectMerges = false }) {
  const config = { ...configuration };
  const t0 = performance.now();
  const records = [];
  const listeners = [];
  const cache = new Map();
  const sockets = new Set();
  let step = null;
  const answered = { primary: 0, sub: 0 };
  let clock = 0;
  let toolNumber = 0;
  const badQueue = [];
  const held = [];
  const heldListeners = [];
  if (rawDir) mkdirSync(rawDir, { recursive: true });

  function usageFor(body, outputTokens) {
    const els = elements(body);
    const total = els.reduce((t, e) => t + e.tokens, 0);
    const cum = []; let c = 0;
    for (const e of els) { c += e.tokens; cum.push(c); }
    const markers = els.map((e, i) => (e.marker ? i : -1)).filter((i) => i >= 0);
    let readAt = -1;
    for (const m of markers) {
      for (let j = m; j >= 0 && els[m].position - els[j].position < LOOKBACK_POSITIONS; j--) {
        const entry = cache.get(els[j].hash);
        if (entry && entry.expiresAt > clock && j > readAt) readAt = j;
      }
    }
    const read = readAt >= 0 ? cum[readAt] : 0;
    if (readAt >= 0) {
      const ttl = els[readAt].marker?.ttl === '1h' || cache.get(els[readAt].hash).ttl === ONE_HOUR ? ONE_HOUR : FIVE_MINUTES;
      cache.set(els[readAt].hash, { expiresAt: clock + ttl, ttl });
    }
    const split = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 };
    let written = read;
    for (const m of markers) {
      if (m <= readAt || cum[m] < CACHE_MINIMUM[body.model]) continue;
      const ttl = els[m].marker.ttl === '1h' ? ONE_HOUR : FIVE_MINUTES;
      cache.set(els[m].hash, { expiresAt: clock + ttl, ttl });
      split[ttl === ONE_HOUR ? 'ephemeral_1h_input_tokens' : 'ephemeral_5m_input_tokens'] += cum[m] - written;
      written = cum[m];
    }
    const creation = written - read;
    return { input_tokens: total - written, cache_read_input_tokens: read, cache_creation_input_tokens: creation, cache_creation: split, output_tokens: outputTokens };
  }

  function classify(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || body.messages.length === 0) return { kind: 'unclassified', reason: 'no messages' };
    const unmodelled = UNMODELLED.find((k) => Object.hasOwn(body, k));
    if (unmodelled) return { kind: 'unclassified', reason: `it carries \`${unmodelled}\`, which the stand-in's prompt cache doesn't model` };
    if (CACHE_MINIMUM[body.model] === undefined) return { kind: 'unclassified', reason: `the stand-in knows no minimum cacheable length for the model ${body.model}` };
    if (body.max_tokens === 0) return { kind: 'unclassified', reason: 'max_tokens 0, the shape of a cache keepalive refresh' };
    const last = body.messages.at(-1);
    const lastBlock = blocksOf(last.content).at(-1);
    if (last.role === 'user' && lastBlock?.type === 'text' && INSTRUCTIONS.some((re) => re.test(lastBlock.text || ''))) {
      return requestedTarget(lastBlock.text) === null ? { kind: 'unclassified', reason: 'its compression instruction states no target length' } : { kind: 'summariser' };
    }
    if (last.role !== 'user') return { kind: 'unclassified', reason: `the last message is the ${last.role}'s` };
    if (!step) return { kind: 'unclassified', reason: 'no step is set' };
    const agent = step.sub && systemText(body).includes(step.sub.marker) ? 'sub' : 'primary';
    const script = agent === 'sub' ? step.sub : step;
    const lastTexts = texts({ messages: [last] });
    const carried = found(lastTexts, CANARY);
    const where = script.namedAnywhere === true ? texts(body) : lastTexts;
    const named = (script.also || []).some((s) => where.some((t) => t.includes(s)))
      || (script.namedAnywhere === true && found(where, CANARY).some((c) => (script.canaries || []).includes(c)));
    if (!named && !carried.some((c) => (script.canaries || []).includes(c))) return { kind: 'unclassified', reason: `its last message carries none of step ${step.id}'s ${agent === 'sub' ? 'subagent\'s ' : ''}canaries (it carries ${carried.join(' ') || 'none'})` };
    if (answered[agent] >= (script.replies || []).length) return { kind: 'unclassified', reason: `step ${step.id} has no scripted ${agent === 'sub' ? 'subagent ' : ''}reply left (${answered[agent]} answered)` };
    return { kind: 'agent', agent };
  }

  function unbound(body) {
    if (!config.binds) return [];
    const out = [];
    for (const [i, m] of body.messages.entries()) {
      for (const [j, b] of blocksOf(m.content).entries()) {
        if (b.type === 'thinking' && b.signature !== signatureFor(bindingIdentity(body, i), b.thinking ?? '')) out.push({ i, j });
      }
    }
    return out;
  }
  const dropsUnbound = (body) => body.thinking?.block_binding?.prefix_mismatch_behavior === 'drop_block';
  function asRead(body) {
    const drop = dropsUnbound(body) ? unbound(body) : [];
    if (!drop.length) return body;
    const gone = new Set(drop.map(({ i, j }) => `${i}.${j}`));
    return { ...body, messages: body.messages.map((m, i) => (Array.isArray(m.content) ? { ...m, content: m.content.filter((_, j) => !gone.has(`${i}.${j}`)) } : m)) };
  }
  // The extended-thinking page: "If thinking blocks are modified, the API returns a 400 `invalid_request_error`
  // whose message contains `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be
  // modified" (https://platform.claude.com/docs/en/build-with-claude/extended-thinking). The troubleshooting page:
  // where a signature "didn't verify: it was truncated, altered, or sent back empty", "`prefix_mismatch_behavior`
  // doesn't apply. Edited thinking text returns a different error. See A 400 error says thinking blocks cannot be
  // modified" (https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting), which doesn't limit
  // edited text to the latest message. So where the model binds, and earlier thinking is replayed, an edited block in
  // any assistant message is refused with that error's wording, and the binding check sees only blocks whose text
  // verifies; elsewhere only the latest message is checked.
  function modifiedThinking(body) {
    const last = body.messages.findLastIndex((m) => m.role === 'assistant');
    for (const [i, m] of body.messages.entries()) {
      if (m.role !== 'assistant' || (i !== last && !config.binds)) continue;
      const j = blocksOf(m.content).findIndex((b) => b.type === 'thinking' && !signs(b.signature, b.thinking ?? ''));
      if (j >= 0) return `messages.${i}.content.${j}: \`thinking\` or \`redacted_thinking\` blocks in the latest assistant message cannot be modified`;
    }
    return null;
  }
  function bindingRefusal(body) {
    if (dropsUnbound(body)) return null;
    const [first] = unbound(body);
    return first ? `messages.${first.i}.content.${first.j}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation.` : null;
  }

  const sendError = (res, status, message, { type = 'invalid_request_error', headers = {} } = {}) => {
    const body = JSON.stringify({ type: 'error', error: { type, message } });
    res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_standin', ...headers });
    res.end(body);
  };

  function sendMessage(res, body, record, answer) {
    const fit = fitToMaxTokens(answer.content, body.max_tokens);
    const content = fit.content;
    const stop = fit.cut ? 'max_tokens' : answer.stop;
    if (fit.cut) Object.assign(record.answer, { stop, chars: content.reduce((t, b) => t + (b.text || b.thinking || '').length, 0), ...(record.answer.toolUseIds ? { toolUseIds: content.filter((b) => b.type === 'tool_use').map((b) => b.id) } : {}) });
    const outputTokens = content.reduce((t, b) => t + blockTokens(b), 0) || 1;
    const usage = usageFor(asRead(body), stop === 'max_tokens' && body.max_tokens ? body.max_tokens : outputTokens);
    record.usage = usage;
    if (rawDir) writeFileSync(join(rawDir, `${record.id}.answer.json`), JSON.stringify(content));
    const message = { id: `msg_${record.id}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, usage };
    if (!body.stream) {
      const out = JSON.stringify(message);
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_${record.id}` });
      res.end(out);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_${record.id}` });
    const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    ev('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } });
    content.forEach((b, index) => {
      if (b.type === 'text') {
        ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
      } else if (b.type === 'thinking') {
        ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
        ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } });
        ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } });
      } else if (b.type === 'tool_use') {
        ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      }
      ev('content_block_stop', { index });
    });
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
    ev('message_stop', {});
    res.end();
  }

  function answerAgent(res, body, record, reply) {
    const identity = bindingIdentity(body, body.messages.length);
    const content = [];
    const thinking = reply.thinking ?? (config.thinks ? prose(THINKING_CHARS, parseInt(bindingIdentity(maskRunVarying(body), body.messages.length).slice(0, 8), 16)) : undefined);
    if (thinking !== undefined) content.push({ type: 'thinking', thinking, signature: signatureFor(identity, thinking) });
    if (reply.text !== undefined) content.push({ type: 'text', text: reply.text });
    for (const call of reply.calls || []) content.push({ type: 'tool_use', id: call.id ?? `toolu_fx${String(++toolNumber).padStart(6, '0')}`, name: call.name, input: call.input });
    const stop = reply.stop ?? ((reply.calls || []).length ? 'tool_use' : 'end_turn');
    record.answer = { shape: 'reply', chars: content.reduce((t, b) => t + (b.text || b.thinking || '').length, 0), stop, toolUseIds: content.filter((b) => b.type === 'tool_use').map((b) => b.id) };
    sendMessage(res, body, record, { content, stop });
  }

  function summariserShape(read, record) {
    const merge = record.level >= 2;
    if (rejectMerges && merge) return 'rejection';
    if (refuseMerges && merge) return 'refusal';
    if (badQueue.length && !record.retry) return badQueue.shift();
    return 'summary';
  }

  function answerSummariser(res, body, record, read) {
    const shape = record.answer.shape;
    if (shape === 'rejection') return sendError(res, 400, `stand-in: merge request ${record.id} is rejected for its request`);
    const seed = sha([read.target, read.canaries.join(','), read.recalled.join(',')].join('\u0000'));
    const words = parseInt(seed.slice(8, 16), 16);
    const summary = `[[s:M${seed.slice(0, 8)}]]`;
    const head = `${summary} Memory ${seed.slice(0, 8)}, carried ${read.canaries.length} canaries to ${read.canaries.at(-1)?.slice(2, -2) ?? 'none'}:`;
    const memory = (chars) => `${head} ${prose(chars - head.length - 1, words)}`;
    let content; let stop = 'end_turn';
    if (shape === 'refusal') { content = [{ type: 'text', text: 'I can\'t help with that.' }]; stop = 'refusal'; }
    else if (shape === 'empty') content = [{ type: 'text', text: '' }];
    else if (shape === 'thinking-only') content = [{ type: 'text', text: `<thinking>${prose(200, words)}</thinking>` }];
    else if (shape === 'max-tokens') content = [{ type: 'text', text: memory(Math.ceil(body.max_tokens * RATE.prose * 2)) }];
    else content = [{ type: 'text', text: memory(Math.floor(record.target * RATE.prose)) }];
    if (['summary', 'max-tokens'].includes(shape)) record.answer.summary = summary;
    record.answer.chars = content.reduce((t, b) => t + (b.text ?? b.thinking ?? '').length, 0);
    record.answer.stop = stop;
    sendMessage(res, body, record, { content, stop });
  }

  function handle(req, res, raw, arrived) {
    const url = req.url || '';
    const path = url.split('?')[0];
    // A query selects an endpoint's behaviour (the SDK's beta messages add `?beta=true`), so the head keeps one.
    const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : null;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    const seq = records.length + 1;
    const id = `r${seq}`;
    const routed = req.method === 'POST' && path.endsWith('/v1/messages');
    const { kind, agent, reason } = routed ? classify(body) : { kind: 'unclassified', reason: `it goes to ${req.method} ${path}, which no run sends and the stand-in doesn't model` };
    const mask = runVaryingMasker();
    const record = { id, seq, at: Math.round(performance.now() - t0), arrived, clock, step: step?.id ?? null, kind, ...(agent ? { agent } : {}), ...(reason ? { reason } : {}), ...(body ? normalise(body, req.headers, mask) : {}) };
    if (query !== null && record.head) record.head.query = query;
    if (path !== '/v1/messages' && record.head) record.head.path = path;
    if (kind === 'summariser' && body) record.texts = summariserTexts(body, mask);
    records.push(record);
    if (rawDir) writeFileSync(join(rawDir, `${id}.json`), raw);
    for (const cb of listeners) cb({ id, seq, kind, step: record.step, at: record.at, clock });
    if (kind === 'unclassified') {
      record.answer = { shape: 'refused' };
      return sendError(res, routed ? 400 : 404, `stand-in: unclassified request ${id}: ${reason}`);
    }
    if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) {
      record.refused = 'max_tokens';
      record.answer = { shape: 'refused' };
      if (kind === 'agent') answered[agent]++;
      return sendError(res, 400, 'max_tokens: Field required');
    }
    const tooLong = countTokens(asRead(body));
    if (tooLong > config.windowTokens) {
      record.refused = 'window';
      record.answer = { shape: 'refused' };
      if (kind === 'agent') answered[agent]++;
      return sendError(res, 400, `prompt is too long: ${tooLong} tokens > ${config.windowTokens} maximum`);
    }
    const modified = modifiedThinking(body);
    if (modified) {
      record.refused = 'thinking-modified';
      record.answer = { shape: 'refused' };
      if (kind === 'agent') answered[agent]++;
      return sendError(res, 400, modified);
    }
    const binding = bindingRefusal(body);
    if (binding) {
      record.refused = 'thinking';
      record.answer = { shape: 'refused' };
      if (kind === 'agent') answered[agent]++;
      return sendError(res, 400, binding);
    }
    if (kind === 'agent') {
      const reply = (agent === 'sub' ? step.sub : step).replies[answered[agent]++];
      if (reply.error) {
        record.answer = { shape: 'error', status: reply.error.status };
        return sendError(res, reply.error.status, reply.error.message ?? 'stand-in: scripted error', { type: reply.error.type, headers: reply.error.headers });
      }
      if (reply.settle) {
        held.push(() => answerAgent(res, body, record, reply));
        for (const cb of heldListeners) cb({ id, agent, step: record.step });
        return;
      }
      answerAgent(res, body, record, reply);
      return;
    }
    record.sent = { canaries: found(texts(body), CANARY), summaries: found(texts(body), SUMMARY) };
    const instruction = blocksOf(body.messages.at(-1).content).at(-1).text;
    record.level = requestedLevel(instruction);
    record.target = requestedTarget(instruction);
    record.retry = /do not call any tools for this|do not wrap it in <thinking>/.test(instruction);
    const read = readSummariser(body, record.target);
    record.answer = { shape: summariserShape(read, record) };
    answerSummariser(res, body, record, read);
  }

  const server = createServer((req, res) => {
    const arrived = String(process.hrtime.bigint());
    let raw = '';
    req.setEncoding('utf-8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => handle(req, res, raw, arrived));
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    setStep(next) { step = next; answered.primary = 0; answered.sub = 0; badQueue.push(...(next?.badAnswers || [])); },
    setClock(ms) { clock = ms; },
    countTokens(body) { return countTokens(asRead(body)); },
    onRequest(cb) { listeners.push(cb); },
    onHeld(cb) { heldListeners.push(cb); },
    releaseHeld() { held.shift()?.(); },
    async close() {
      await new Promise((resolve) => { server.close(() => resolve()); for (const s of sockets) s.destroy(); });
      return records;
    },
  };
}
