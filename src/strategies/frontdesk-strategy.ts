import { AutobiographicalStrategy } from '@animalabs/context-manager';
import type {
  AutobiographicalConfig,
  ContextEntry,
  MessageStoreView,
  ContextLogView,
  TokenBudget,
  StoredMessage,
  SummaryEntry,
} from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { formatZonedTime, resolveTimeZone } from '@animalabs/agent-framework';

// Structural mirror of AutobiographicalStrategy's internal Chunk.
// Kept inline because @animalabs/context-manager does not currently export it.
interface Chunk {
  index: number;
  startIndex: number;
  endIndex: number;
  messages: StoredMessage[];
  tokens: number;
  compressed: boolean;
  diary?: string;
  summaryId?: string;
  phaseType?: string;
}

export type FrontdeskStrategyOptions = Partial<AutobiographicalConfig> & { timeZone?: string };

/**
 * Chatbot-flavoured context strategy for agents that receive messages via
 * MCPL channels (Zulip, Discord, etc.) and reply back through them.
 *
 * Extends AutobiographicalStrategy with three features:
 *  1. Provenance wrapping — prepends a `[zulip · #channel · topic · @user · HH:MM · msg-id]`
 *     header to each MCPL-originated entry so the agent knows the message came from a
 *     channel and which reply path to use.
 *  2. Topic-aware compression — chunk boundaries prefer Zulip-topic transitions and the
 *     compression prompt instructs per-topic structure.
 *  3. Question/mention salience — unanswered user questions and @mentions are preserved
 *     verbatim longer (both during compression and during L1 selection under budget).
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
  ): ContextEntry[] {
    this.updateSalience(store);
    const entries = super.select(store, log, budget);
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
   * Override rebuildChunks to additionally close chunk boundaries at Zulip-topic
   * transitions. Falls back to base size/count behaviour when topic metadata is absent.
   */
  protected override rebuildChunks(store: MessageStoreView): void {
    const messagesToChunk = this.getCompressibleMessages(store);

    const existingCompressed = new Map<string, Chunk>();
    for (const chunk of this.chunks as unknown as Chunk[]) {
      if (chunk.compressed) {
        existingCompressed.set(this.chunkKey(chunk as never), chunk);
      }
    }

    this.chunks = [];
    this.compressionQueue = [];

    let currentChunk: StoredMessage[] = [];
    let currentTokens = 0;
    let chunkFilteredStart = 0;
    const MIN_CHUNK = 4;

    const push = (startIdx: number, endIdx: number, msgs: StoredMessage[], tokens: number) => {
      const chunk = this.createChunk(
        this.chunks.length,
        startIdx,
        endIdx,
        msgs,
        tokens,
        existingCompressed as never,
      );
      this.chunks.push(chunk);
      if (!chunk.compressed) this.compressionQueue.push(chunk.index);
    };

    for (let i = 0; i < messagesToChunk.length; i++) {
      const msg = messagesToChunk[i];
      let msgTokens = store.estimateTokens(msg);
      if (this.config.attachmentsIgnoreSize) {
        msgTokens = this.estimateTextOnlyTokens(msg);
      }

      // Topic boundary: close current chunk BEFORE adding msg when topic changes
      // and the chunk has at least MIN_CHUNK messages. This keeps summaries of
      // unrelated topics from being merged.
      if (
        currentChunk.length >= MIN_CHUNK &&
        this.isTopicBoundary(currentChunk[currentChunk.length - 1], msg)
      ) {
        push(chunkFilteredStart, i, currentChunk, currentTokens);
        currentChunk = [];
        currentTokens = 0;
        chunkFilteredStart = i;
      }

      currentChunk.push(msg);
      currentTokens += msgTokens;

      const shouldClose =
        currentTokens >= this.config.targetChunkTokens && currentChunk.length >= MIN_CHUNK;

      if (shouldClose) {
        push(chunkFilteredStart, i + 1, currentChunk, currentTokens);
        currentChunk = [];
        currentTokens = 0;
        chunkFilteredStart = i + 1;
      }
    }

    if (currentChunk.length >= MIN_CHUNK) {
      push(chunkFilteredStart, messagesToChunk.length, currentChunk, currentTokens);
    }
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
    const topics = new Set<string>();
    for (const m of chunk.messages) {
      const t = this.extractTopicKey(m);
      if (t) topics.add(t);
    }

    const openQuestions: string[] = [];
    for (const m of chunk.messages) {
      if (this.salientSourceIds.has(m.id)) {
        const text = this.extractText(m.content).trim().replace(/\s+/g, ' ');
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
  // Feature 3b: Salience-biased L1 selection
  // ==========================================================================

  protected override selectL1Summaries(
    shownL1: SummaryEntry[],
    budget: number,
    maxTokens: number,
  ): { selected: SummaryEntry[]; tokensUsed: number } {
    if (shownL1.length === 0) return { selected: [], tokensUsed: 0 };

    const isSalient = (s: SummaryEntry): boolean =>
      s.sourceIds.some((id) => this.salientSourceIds.has(id));

    const salient: SummaryEntry[] = [];
    const routine: SummaryEntry[] = [];
    for (const s of shownL1) {
      (isSalient(s) ? salient : routine).push(s);
    }

    const selected: SummaryEntry[] = [];
    let used = 0;

    for (const group of [salient, routine]) {
      for (const s of group) {
        if (used + s.tokens > budget) break;
        if (used + s.tokens > maxTokens) break;
        selected.push(s);
        used += s.tokens;
      }
    }

    return { selected, tokensUsed: used };
  }

  // ==========================================================================
  // Salience tracking (shared by 3a and 3b)
  // ==========================================================================

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
    for (const b of msg.content) {
      if (b.type !== 'text') continue;
      const text = b.text;
      if (text.includes('?')) return true;
      if (/@\*\*[^*]+\*\*/.test(text)) return true; // Zulip-style mention
      if (/(^|\s)@[A-Za-z][\w-]*/.test(text)) return true; // Discord/Slack-style
    }
    return false;
  }
}
