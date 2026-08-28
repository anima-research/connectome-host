import { randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  AgentFramework,
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '@animalabs/agent-framework';

const DEFAULT_CONFIRMATION_TTL_MS = 10 * 60_000;
const DEFAULT_CONFIRMATION_DELAY_MS = 60_000;
const CONFIRMATION_PHRASE = 'RETIRE_RESIDENT';

export type RetirementReadiness =
  | { ready: true }
  | { ready: false; code: string; reason: string };

export type RetirementReadinessCheck = (
  phase: 'request' | 'confirm',
) => RetirementReadiness;

export interface ResidentLifecycleModuleConfig {
  agentName: string;
  enabled: boolean;
  confirmationTtlMs?: number;
  confirmationDelayMs?: number;
  readinessCheck: RetirementReadinessCheck;
  now?: () => number;
}

interface PendingChallenge {
  value: string;
  confirmableAt: number;
  expiresAt: number;
}

type LifecycleFramework = AgentFramework & {
  retireResident(agentName: string, reason?: string): {
    status: 'retired';
    retiredAt: number;
    reason?: string;
    chronicleRecorded: boolean;
    alreadyRetired: boolean;
  };
};

/** Host-owned resident wording and two-turn confirmation policy. */
export class ResidentLifecycleModule implements Module {
  readonly name = 'resident';
  private readonly agentName: string;
  private readonly enabled: boolean;
  private readonly confirmationTtlMs: number;
  private readonly confirmationDelayMs: number;
  private readonly readinessCheck: RetirementReadinessCheck;
  private readonly now: () => number;
  private framework: LifecycleFramework | null = null;
  private context: ModuleContext | null = null;
  private challenge: PendingChallenge | null = null;
  private confirmationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ResidentLifecycleModuleConfig) {
    this.agentName = config.agentName;
    this.enabled = config.enabled;
    this.confirmationTtlMs = config.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
    this.confirmationDelayMs = config.confirmationDelayMs ?? DEFAULT_CONFIRMATION_DELAY_MS;
    this.readinessCheck = config.readinessCheck;
    this.now = config.now ?? Date.now;
  }

  setFramework(framework: AgentFramework): void {
    this.framework = framework as LifecycleFramework;
  }

  async start(context: ModuleContext): Promise<void> {
    this.context = context;
  }

  async stop(): Promise<void> {
    this.clearTimer();
    this.challenge = null;
    this.context = null;
    this.framework = null;
  }

  getTools(): ToolDefinition[] { return []; }

  getLiveTools(agentName: string): ToolDefinition[] {
    if (!this.enabled || agentName !== this.agentName) return [];
    return [{
      name: 'lifecycle',
      description:
        'Inspect or irreversibly retire this resident identity. Retirement permanently ' +
        'prevents future model inference for this resident. It is not end-turn or sleep, ' +
        'and it does not erase Chronicle, messages, workspace files, or other history. ' +
        'Requesting retirement ends this turn. After a cooling-off interval, you receive ' +
        'one separate confirmation turn and may confirm using the fresh challenge. No human ' +
        'approval is requested. Local memory-health checks may defer either step.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'request_retirement', 'confirm_retirement'],
          },
          challenge: { type: 'string' },
          confirmation: { type: 'string', enum: [CONFIRMATION_PHRASE] },
          reason: {
            type: 'string',
            description: 'Optional resident-authored reason retained with the terminal record.',
          },
        },
        required: ['action'],
      },
    }];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (!this.enabled || call.name !== 'lifecycle' || call.callerAgentName !== this.agentName) {
      return { success: false, isError: true, error: 'resident lifecycle tool is unavailable' };
    }
    const framework = this.requireFramework();
    const input = (call.input ?? {}) as {
      action?: unknown;
      challenge?: unknown;
      confirmation?: unknown;
      reason?: unknown;
    };

    if (input.action === 'status') {
      const pending = this.activeChallenge();
      return {
        success: true,
        data: {
          ...framework.getResidentLifecycleStatus(this.agentName),
          confirmationPending: pending !== null,
          ...(pending ? {
            confirmationConfirmableAt: pending.confirmableAt,
            confirmationExpiresAt: pending.expiresAt,
          } : {}),
        },
      };
    }

    if (input.action === 'request_retirement') {
      const readiness = this.readiness('request');
      if (!readiness.ready) return this.notReady(readiness, 'request');
      const now = this.now();
      this.challenge = {
        value: randomUUID(),
        confirmableAt: now + this.confirmationDelayMs,
        expiresAt: now + this.confirmationTtlMs,
      };
      this.scheduleConfirmationWake(this.challenge);
      return {
        success: true,
        endTurn: true,
        data: {
          status: 'confirmation_required',
          challenge: this.challenge.value,
          confirmableAt: this.challenge.confirmableAt,
          expiresAt: this.challenge.expiresAt,
          semantics:
            'Confirming permanently prevents future model inference for this resident. ' +
            'Chronicle, messages, workspace files, and other history remain. This is not ' +
            'sleep, end-turn, or erasure, and it cannot be reversed through Connectome.',
          next:
            `After the cooling-off boundary, call resident--lifecycle with ` +
            `action="confirm_retirement", this challenge, and confirmation="${CONFIRMATION_PHRASE}". ` +
            'No human approval is requested.',
        },
      };
    }

    if (input.action === 'confirm_retirement') {
      const pending = this.activeChallenge();
      const now = this.now();
      if (!pending) {
        return {
          success: false,
          isError: true,
          error: 'No unexpired retirement challenge. Call request_retirement to begin again.',
        };
      }
      if (pending.confirmableAt > now) {
        return {
          success: false,
          isError: true,
          error: 'The retirement cooling-off interval has not elapsed. The challenge remains pending.',
          data: {
            status: 'cooling_off',
            confirmableAt: pending.confirmableAt,
            expiresAt: pending.expiresAt,
          },
        };
      }
      const readiness = this.readiness('confirm');
      if (!readiness.ready) return this.notReady(readiness, 'confirm', pending.expiresAt);

      // A confirmation attempt after the cooling-off boundary is one-use.
      this.challenge = null;
      this.clearTimer();
      if (
        typeof input.challenge !== 'string' ||
        !this.challengeMatches(pending.value, input.challenge) ||
        input.confirmation !== CONFIRMATION_PHRASE
      ) {
        return {
          success: false,
          isError: true,
          error:
            `Retirement was not confirmed. Supply the fresh challenge exactly and ` +
            `confirmation="${CONFIRMATION_PHRASE}" before it expires.`,
        };
      }

      try {
        const result = framework.retireResident(
          this.agentName,
          typeof input.reason === 'string' ? input.reason : undefined,
        );
        this.context?.notifyOps?.(
          'resident-retired',
          this.agentName,
          `Resident ${this.agentName} applied its irreversible retirement seal. History was preserved.`,
          { retiredAt: result.retiredAt, chronicleRecorded: result.chronicleRecorded },
        );
        return {
          success: true,
          endTurn: true,
          data: { ...result, historyPreserved: true },
        };
      } catch (error) {
        return {
          success: false,
          isError: true,
          error: `Retirement was not recorded: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    return {
      success: false,
      isError: true,
      error: 'action must be status, request_retirement, or confirm_retirement',
    };
  }

  async onProcess(_event: ProcessEvent): Promise<EventResponse> { return {}; }

  private requireFramework(): LifecycleFramework {
    if (!this.framework) throw new Error('resident lifecycle module is not wired to the framework');
    return this.framework;
  }

  private readiness(phase: 'request' | 'confirm'): RetirementReadiness {
    try {
      const result = this.readinessCheck(phase);
      if (!result || typeof result !== 'object' || typeof result.ready !== 'boolean') {
        throw new Error('readiness check returned an invalid result');
      }
      return result.ready
        ? { ready: true }
        : {
            ready: false,
            code: typeof result.code === 'string' && result.code ? result.code : 'not_ready',
            reason: typeof result.reason === 'string' && result.reason
              ? result.reason
              : 'Retirement is temporarily unavailable because memory health was not established.',
          };
    } catch (error) {
      console.error(`[resident-retirement] readiness check failed during ${phase}:`, error);
      return {
        ready: false,
        code: 'readiness_check_failed',
        reason: 'Retirement is temporarily unavailable because memory health could not be verified.',
      };
    }
  }

  private notReady(
    readiness: Exclude<RetirementReadiness, { ready: true }>,
    phase: 'request' | 'confirm',
    expiresAt?: number,
  ): ToolResult {
    return {
      success: false,
      isError: true,
      error: readiness.reason,
      data: {
        status: 'not_ready',
        code: readiness.code,
        phase,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      },
    };
  }

  private activeChallenge(): PendingChallenge | null {
    if (!this.challenge) return null;
    if (this.challenge.expiresAt <= this.now()) {
      this.challenge = null;
      this.clearTimer();
      return null;
    }
    return this.challenge;
  }

  private scheduleConfirmationWake(challenge: PendingChallenge): void {
    this.clearTimer();
    const timer = setTimeout(() => {
      this.confirmationTimer = null;
      if (this.challenge !== challenge || !this.activeChallenge()) return;
      const result = this.framework?.nudgeAgent(
        this.agentName,
        'resident-lifecycle',
      );
      if (result && !result.ok) {
        console.error(`[resident-retirement] confirmation wake was not queued: ${result.error}`);
      }
    }, Math.max(0, challenge.confirmableAt - this.now()));
    timer.unref?.();
    this.confirmationTimer = timer;
  }

  private clearTimer(): void {
    if (!this.confirmationTimer) return;
    clearTimeout(this.confirmationTimer);
    this.confirmationTimer = null;
  }

  private challengeMatches(expected: string, supplied: string): boolean {
    const a = Buffer.from(expected);
    const b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
