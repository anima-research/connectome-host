/**
 * agent-framework stores a module's `afterUser` injection in the
 * agent's store, under participant `system_context:<namespace>`,
 * marked as its `storedInjectionMarkOf` reads.
 */
import { storedInjectionMarkOf, type StoredInjectionMark } from '@animalabs/agent-framework';
import type { CompileResult } from '@animalabs/context-manager';

export function storedInjectionLabel(mark: Pick<StoredInjectionMark, 'agent' | 'namespace'>): string {
  return `[${mark.namespace}, injected for ${mark.agent}]`;
}

/** A compiled message carries no metadata, so the compile's provenance
 *  decides which are stored injections. */
export function compiledWithoutStoredInjections<M>(
  result: { messages: M[] } & Pick<CompileResult, 'provenance' | 'rawBodies'>,
): M[] {
  return result.messages.filter((_, i) => {
    const source = result.provenance?.messages[i];
    if (source?.kind !== 'raw' || source.bodies.length === 0) return true;
    return !source.bodies.every((body) => {
      const head = result.rawBodies?.get(body.messageId)?.[0];
      return head !== undefined && storedInjectionMarkOf(head.metadata) !== undefined;
    });
  });
}
