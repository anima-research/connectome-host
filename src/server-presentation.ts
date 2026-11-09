import type { McplServerConfig } from '@animalabs/agent-framework';

export type ServerPresentation = NonNullable<McplServerConfig['presentation']>;

/** agent-framework's entry exports the presentation type, through McplServerConfig, but not its values. */
export const SERVER_PRESENTATIONS = ['full', 'tab', 'closed-tab'] as const satisfies readonly ServerPresentation[];
type EveryOneListed<Unlisted extends never> = Unlisted;
type _PresentationsListed = EveryOneListed<Exclude<ServerPresentation, (typeof SERVER_PRESENTATIONS)[number]>>;

export const isServerPresentation = (value: unknown): value is ServerPresentation =>
  typeof value === 'string' && (SERVER_PRESENTATIONS as readonly string[]).includes(value);

/** `"full", "tab" or "closed-tab"`, for a refusal naming the values. */
export const SERVER_PRESENTATIONS_TEXT = SERVER_PRESENTATIONS.map((p) => JSON.stringify(p)).join(', ')
  .replace(/, ([^,]*)$/, ' or $1');
