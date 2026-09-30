import * as agentFramework from '@animalabs/agent-framework';
import type { Recipe } from './recipe.js';

/**
 * Fail closed across a staged Agent Framework release: an older framework
 * silently ignores an unknown `proseOutbox` config key, so a recipe that
 * enables it would look valid while undelivered speech was still lost.
 * The framework exports `ProseOutbox` in the same release that honours the
 * option.
 */
export function assertProseOutboxSupport(
  recipe: Recipe,
  framework: Record<string, unknown> = agentFramework as unknown as Record<string, unknown>,
): void {
  if (!recipe.proseOutbox?.enabled) return;
  if (typeof framework.ProseOutbox !== 'function') {
    throw new Error(
      'This recipe enables proseOutbox, but the installed Agent Framework does not support it.',
    );
  }
}
