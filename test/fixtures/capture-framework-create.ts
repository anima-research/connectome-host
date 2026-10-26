/**
 * `bun --preload` fixture: replaces AgentFramework.create with a stub that
 * writes the option keys and the scalar values it was handed to
 * $CAPTURE_FRAMEWORK_CREATE, then exits. Lets a test pin what src/index.ts
 * forwards to the framework without booting it.
 */
import { writeFileSync } from 'node:fs';
import { AgentFramework } from '@animalabs/agent-framework';

const out = process.env.CAPTURE_FRAMEWORK_CREATE;
if (!out) throw new Error('capture-framework-create: CAPTURE_FRAMEWORK_CREATE is not set');

(AgentFramework as { create: unknown }).create = async (options: Record<string, unknown>) => {
  const scalars = Object.fromEntries(
    Object.entries(options).filter(([, v]) => v === null || typeof v !== 'object' && typeof v !== 'function'),
  );
  writeFileSync(out, JSON.stringify({ keys: Object.keys(options), scalars }), 'utf-8');
  process.exit(0);
};
