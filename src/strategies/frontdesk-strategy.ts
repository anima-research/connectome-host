import { AutobiographicalStrategy } from '@animalabs/context-manager';
import type {
  AutobiographicalConfig,
  Chunk,
  ContextEntry,
  MessageStoreView,
  ContextLogView,
  TokenBudget,
  StoredMessage,
} from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { formatZonedTime, resolveTimeZone } from '@animalabs/agent-framework';

export type FrontdeskStrategyOptions = Partial<AutobiographicalConfig> & { timeZone?: string };

/**
 * Chatbot-flavoured context strategy for agents that receive messages via
 * MCPL channels (Zulip, Discord, etc.) and reply back through them.
 *
 * Extends AutobiographicalStrategy with three features:
 *  1. Provenance wrapping — prepends a `[zulip · #channel · topic · @user · HH:MM · msg-id]`
 *     header to each MCPL-originated entry so the agent knows the message came from a
 *     channel and which reply path to use. Skipped for a message whose server already
 *     rendered that into the body (metadata `attributed: true`, e.g. zulip-mcp).
 *  2. Topic-aware compression — chunk boundaries close at Zulip-topic transitions
 *     (via the base chunker's `chunkBoundaryHint` seam) and the compression prompt
 *     instructs per-topic structure.
 *  3. Question/mention salience — unanswered user questions and @mentions are named
 *     verbatim in the compression prompt so summaries preserve them.
 *
 * History note: through conhost 0.7.x this class forked the whole of
 * `rebuildChunks` for feature 2 — written against a pre-chunk-persistence
 * base, silently bypassing chunk records and the fail-closed orphan guard —
 * and biased the hierarchical renderer's L1 selection for feature 3.
 * Frontdesk agents now ride the adaptive path (see framework-strategy.ts
 * defaults): chunking goes through the base implementation with a boundary
 * hint, and salient content survives through the compression prompt rather
 * than selection-order bias. Stores created by the fork carry no chunk
 * records; context-manager's `migrateChunkRecords` backfills them from L1
 * `sourceIds` on first load.
 */
export class FrontdeskStrategy extends AutobiographicalStrategy {
  override readonly name: string = 'frontdesk';

  private salientSourceIds: Set<string> = new Set();
  private readonly timeZone: string;

  constructor(options: FrontdeskStrategyOptions = {}) {
    const { timeZone, ...strategyOptions } = options;
    super(strategyOptions);
    this.timeZone = resolveTimeZone(timeZone);
  }

  override select(
    store: MessageStoreView,
    log: ContextLogView,
    budget: TokenBudget,
    // Passed through whole: without it a dry run (a preview, the context
    // curve) reached the autobiographical select as a committing one. The
    // package root doesn't export SelectOptions, so it's named by position.
    opts?: Parameters<AutobiographicalStrategy['select']>[3],
  ): ContextEntry[] {
    this.updateSalience(store);
    const entries = super.select(store, log, budget, opts);
    return entries.map((e) => this.wrapProvenance(e, store));
  }

  // ==========================================================================
  // Feature 1: Provenance wrapping
  // ==========================================================================

  protected wrapProvenance(entry: ContextEntry, store: MessageStoreView): ContextEntry {
    if (!entry.sourceMessageId || entry.sourceRelation !== 'copy') return entry;
    const msg = store.get(entry.sourceMessageId);
    if (!msg) return entry;
    const header = this.buildProvenanceHeader(msg);
    if (!header) return entry;

    // Prepend a text block. If the first block is already text, merge the header
    // into it so tool_use/tool_result blocks stay paired with their neighbours.
    const first = entry.content[0];
    if (first && first.type === 'text') {
      return {
        ...entry,
        content: [
          { type: 'text', text: `${header}${first.text}` } as ContentBlock,
          ...entry.content.slice(1),
        ],
      };
    }
    return {
      ...entry,
      content: [{ type: 'text', text: header } as ContentBlock, ...entry.content],
    };
  }

  protected buildProvenanceHeader(msg: StoredMessage): string | null {
    const meta = (msg.metadata ?? {}) as Record<string, unknown>;
    if (meta.serverId === undefined || meta.serverId === null || meta.serverId === '') {
      return null;
    }
    // The server already put who/where/when/id into the body. A second header
    // would repeat it, and would be the weaker of the two: on push/event the
    // stored metadata is the event origin (`authorName`, no `author` object),
    // and channels/incoming stores no source timestamp, so recovered replays
    // would show receipt time.
    if (this.isServerAttributed(msg)) return null;

    const parts: string[] = [];
    const serverId = String(meta.serverId);
    const channelId = meta.channelId !== undefined && meta.channelId !== null ? String(meta.channelId) : '';

    const protocol = this.deriveProtocol(serverId, channelId);
    if (protocol) parts.push(protocol);

    if (channelId) {
      const stripped = channelId.replace(/^[a-z][a-z0-9_-]*:/, '');
      if (stripped) parts.push(`#${stripped}`);
    }

    const topicRaw = meta.topic ?? meta.subject;
    const topic = topicRaw !== undefined && topicRaw !== null ? String(topicRaw) : '';
    if (topic) parts.push(`topic "${topic}"`);

    const author = meta.author as { id?: string; name?: string } | undefined;
    if (author && typeof author === 'object') {
      const display = author.name || author.id || '';
      if (display) parts.push(`@${display}`);
    }

    const ts = this.formatTimestamp(meta.timestamp, msg.timestamp);
    if (ts) parts.push(ts);

    if (meta.messageId !== undefined && meta.messageId !== null && meta.messageId !== '') {
      // Render the FULL id — truncating (an old token-saving trim) corrupts
      // Discord snowflakes, so every reply_message/fetch_around/add_reaction
      // call the agent copies from its own context 404s with Unknown message.
      parts.push(`msg ${String(meta.messageId)}`);
    }

    const threadId = meta.threadId !== undefined && meta.threadId !== null ? String(meta.threadId) : '';
    if (threadId && threadId !== topic) {
      parts.push(`thread ${threadId}`);
    }

    if (parts.length === 0) return null;
    return `[${parts.join(' · ')}]\n`;
  }

  /** The server rendered provenance into the body itself (zulip-mcp's stamp). Strictly the boolean. */
  protected isServerAttributed(msg: StoredMessage): boolean {
    return ((msg.metadata ?? {}) as Record<string, unknown>).attributed === true;
  }

  /**
   * The message's text blocks as written by the sender: a server-attributed
   * message has its `attributionHeader` (the exact prefix the server added)
   * removed from the block that starts with it, so text scans see the body,
   * not the author, stream or topic names in the prefix. Without a matching
   * prefix the text is returned as is.
   */
  protected bodyTextBlocks(msg: StoredMessage): string[] {
    const meta = (msg.metadata ?? {}) as Record<string, unknown>;
    const prefix = this.isServerAttributed(msg) && typeof meta.attributionHeader === 'string' ? meta.attributionHeader : '';
    let stripped = prefix === '';
    const texts: string[] = [];
    for (const b of msg.content) {
      if (b.type !== 'text') continue;
      if (!stripped && b.text.startsWith(prefix)) {
        texts.push(b.text.slice(prefix.length));
        stripped = true;
      } else {
        texts.push(b.text);
      }
    }
    return texts;
  }

  protected deriveProtocol(serverId: string, channelId: string): string {
    if (channelId) {
      const match = channelId.match(/^([a-z][a-z0-9_-]*):/);
      if (match) return match[1];
    }
    return serverId;
  }

  protected formatTimestamp(metaTs: unknown, msgTs: Date): string | null {
    let d: Date | null = null;
    if (typeof metaTs === 'string' || typeof metaTs === 'number') {
      const parsed = new Date(metaTs);
      if (!isNaN(parsed.getTime())) d = parsed;
    }
    if (!d && msgTs instanceof Date && !isNaN(msgTs.getTime())) d = msgTs;
    if (!d) return null;
    return formatZonedTime(d, this.timeZone);
  }

  // ==========================================================================
  // Feature 2: Topic-aware chunking
  // ==========================================================================

  /**
   * Close chunk boundaries at Zulip-topic transitions, so summaries of
   * unrelated topics are not fused. Rides the base chunker (context-manager
   * ≥0.6.3): record persistence, minimum-size and tool-pairing guards all
   * apply to hinted closes.
   */
  protected override chunkBoundaryHint(prev: StoredMessage, next: StoredMessage): boolean {
    return this.isTopicBoundary(prev, next);
  }

  protected isTopicBoundary(prev: StoredMessage, curr: StoredMessage): boolean {
    const a = this.extractTopicKey(prev);
    const b = this.extractTopicKey(curr);
    if (!a || !b) return false;
    return a !== b;
  }

  protected extractTopicKey(msg: StoredMessage): string | null {
    const meta = (msg.metadata ?? {}) as Record<string, unknown>;
    const topicRaw = meta.topic ?? meta.subject;
    if (topicRaw === undefined || topicRaw === null || topicRaw === '') return null;
    const channelId = meta.channelId !== undefined && meta.channelId !== null ? String(meta.channelId) : '';
    return `${channelId}::${String(topicRaw)}`;
  }

  // ==========================================================================
  // Feature 3a: Compression instruction with topic + open-question clauses
  // ==========================================================================

  protected override getCompressionInstruction(chunk: Chunk, targetTokens: number): string {
    // Witnessed chunks keep the base treatment (recipe-configurable
    // witnessed prompt); the old fork predated it and steamrolled it.
    if (this.chunkIsWitnessed(chunk)) {
      return super.getCompressionInstruction(chunk, targetTokens);
    }
    const topics = new Set<string>();
    for (const m of chunk.messages) {
      const t = this.extractTopicKey(m);
      if (t) topics.add(t);
    }

    const openQuestions: string[] = [];
    for (const m of chunk.messages) {
      if (this.salientSourceIds.has(m.id)) {
        const text = this.bodyTextBlocks(m).join('\n').trim().replace(/\s+/g, ' ');
        if (text) {
          openQuestions.push(text.length > 200 ? `${text.slice(0, 200)}…` : text);
        }
      }
    }

    const base = `Starting from my last message, please describe everything that has happened. Aim for about ${targetTokens} tokens. Describe it as you would to yourself, as if you are remembering what has happened.`;

    const clauses: string[] = [];
    if (topics.size > 1) {
      clauses.push(
        'This window spans multiple Zulip topics — structure the memory with one short section per topic, keeping topic names verbatim.',
      );
    }
    if (openQuestions.length > 0) {
      clauses.push(
        `Preserve verbatim any user question that was asked in this window and has not yet been answered, including @mentions of the agent. Questions to preserve: ${openQuestions.map((q) => `"${q}"`).join('; ')}.`,
      );
    }

    return clauses.length === 0 ? base : `${base}\n\n${clauses.join(' ')}`;
  }

  // ==========================================================================
  // Salience tracking (feeds the compression instruction)
  // ==========================================================================
  // The pre-adaptive frontdesk also overrode the hierarchical renderer's
  // selectL1Summaries to emit salient L1s first under budget pressure. Under
  // adaptive resolution the picker selects a coverage frontier — emission
  // order is not budget-competitive — so that bias is retired; salient
  // content survives because getCompressionInstruction names it verbatim.

  /**
   * Recompute which user messages are "unanswered questions or mentions":
   * a user message that contains `?` or an @mention and has no assistant
   * message within the following WINDOW messages.
   */
  protected updateSalience(store: MessageStoreView): void {
    const messages = store.getAll();
    const assistant = this.config.summaryParticipant ?? 'Claude';
    const salient = new Set<string>();
    const WINDOW = 8;

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.participant === assistant) continue;
      if (!this.messageIsQuestionOrMention(m)) continue;

      let answered = false;
      const end = Math.min(i + 1 + WINDOW, messages.length);
      for (let j = i + 1; j < end; j++) {
        if (messages[j].participant === assistant) {
          answered = true;
          break;
        }
      }
      if (!answered) salient.add(m.id);
    }

    this.salientSourceIds = salient;
  }

  protected messageIsQuestionOrMention(msg: StoredMessage): boolean {
    for (const text of this.bodyTextBlocks(msg)) {
      if (text.includes('?')) return true;
      if (/@\*\*[^*]+\*\*/.test(text)) return true; // Zulip-style mention
      if (/(^|\s)@[A-Za-z][\w-]*/.test(text)) return true; // Discord/Slack-style
    }
    return false;
  }
}
