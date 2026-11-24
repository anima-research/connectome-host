import type {
  AgentConfig, AutoContinueConfig, ClockConfig, CodeExecutionConfig, ForkReaderConfig, FrameworkConfig, HeartbeatOptions,
  InferenceBoundsOptions, McplServerConfig, MountConfig, PersistentReaderConfig, ReplyJudgeOptions,
} from '@animalabs/agent-framework';
import type { AutobiographicalOptions } from '@animalabs/context-manager';
import type { MembraneConfig } from '@animalabs/membrane';
import type {
  Recipe, RecipeAgent, RecipeAutoContinue, RecipeCodeExecution, RecipeDendrite, RecipeForkReader, RecipeHeartbeat,
  RecipeMcpServer, RecipePersistentReader, RecipeReplyJudge, RecipeSpeech, RecipeStrategy, RecipeToolLifecycle,
  RecipeTuneOut, RecipeWorkspaceMount,
} from '../src/recipe-schema.js';

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type Holds<Host, Package, HostOnly extends PropertyKey = never, PackageOnly extends PropertyKey = never, Differs extends PropertyKey = never> = [
  Exclude<keyof Host, keyof Package | HostOnly>,
  Exclude<keyof Package, keyof Host | PackageOnly>,
  { [K in Exclude<keyof Host & keyof Package, Differs>]-?: Same<Host[K], Package[K]> extends true ? never : K }[Exclude<keyof Host & keyof Package, Differs>],
] extends [never, never, never] ? true : false;

type ObjectArm<T> = Extract<NonNullable<T>, object>;
type RefusalHandling = ObjectArm<RecipeAgent['refusalHandling']>;

const heldToTheirPackages: [
  Holds<NonNullable<RecipeAgent['retry']>, NonNullable<MembraneConfig['retry']>>,
  Holds<ObjectArm<RecipeAgent['clock']>, ClockConfig>,
  Holds<RecipeAutoContinue, AutoContinueConfig>,
  Holds<RefusalHandling, NonNullable<AgentConfig['refusalHandling']>, 'announceHumanTurns', never, 'autoRewind'>,
  Same<RefusalHandling['autoRewind'], NonNullable<AgentConfig['refusalHandling']>['autoRewind'] | null>,
  Holds<NonNullable<RecipeAgent['thinking']>, NonNullable<AgentConfig['thinking']>, 'effort'>,
  Holds<RecipeStrategy, AutobiographicalOptions, 'type', 'attachmentsIgnoreSize' | 'auditOnly' | 'autoTickOnNewMessage'
    | 'chunkOnMessageBoundary' | 'compressionCacheMarkers' | 'compressionCacheTtl' | 'diarySystemPrompt' | 'diaryUserPrompt'
    | 'hierarchical' | 'imageByteCeiling' | 'imageCeiling' | 'imageStripHysteresisRatio' | 'logEffectiveConfig'
    | 'maxCompressionImageBytes' | 'mergeAttemptLimit' | 'mergeContiguityGapLimit' | 'mergeHoldSummaryIds' | 'minChunkCharsForLLM'
    | 'persistMintPreimages' | 'quarantineAlarmIntervalMs' | 'recallEnvelope' | 'topologyPolicy'>,
  Holds<RecipeWorkspaceMount, MountConfig, never, never, 'mode'>,
  Same<RecipeWorkspaceMount['mode'], MountConfig['mode'] | undefined>,
  Holds<RecipeReplyJudge, ReplyJudgeOptions>,
  Holds<RecipeHeartbeat, ObjectArm<HeartbeatOptions>>,
  Holds<RecipeCodeExecution, CodeExecutionConfig>,
  Holds<RecipePersistentReader, PersistentReaderConfig, never, 'foreignRounds' | 'physicalWindowTokens' | 'thinkingBinding'>,
  Holds<RecipeForkReader, ForkReaderConfig, never, 'framing' | 'strategyFactory' | 'physicalWindowTokens' | 'thinkingBinding'>,
  Holds<RecipeSpeech, NonNullable<FrameworkConfig['speech']>>,
  Holds<RecipeTuneOut, NonNullable<FrameworkConfig['tuneOut']>, 'enabled'>,
  Holds<RecipeDendrite, NonNullable<FrameworkConfig['dendrite']>, never, 'beforeDerive' | 'derivationNotice'>,
  Holds<ObjectArm<Recipe['inferenceBounds']>, InferenceBoundsOptions>,
  Holds<RecipeMcpServer, McplServerConfig, 'access' | 'credentialFiles' | 'source' | 'sourceMeta',
    'id' | 'accessProvider' | 'shouldTriggerInference', 'args' | 'env'>,
  Holds<RecipeToolLifecycle, NonNullable<McplServerConfig['toolLifecycle']>>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
void heldToTheirPackages;

const holdsSeesAPackagesChange: [
  Holds<{ a?: number }, { a?: number; added?: number }>,
  Holds<{ a?: { b?: number } }, { a?: { b?: number; added?: number } }>,
  Holds<{ a?: 'x' | 'y' }, { a?: 'x' | 'y' | 'added' }>,
] = [false, false, false];
void holdsSeesAPackagesChange;

const misspeltKeysFailTheBuild = [
  // @ts-expect-error
  (r: Recipe): unknown => r.nmae,
  // @ts-expect-error
  (r: Recipe): unknown => r.agent.modle,
  // @ts-expect-error
  (r: Recipe): unknown => r.modules?.worksapce,
];
void misspeltKeysFailTheBuild;
