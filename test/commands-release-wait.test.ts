import { describe, test, expect } from 'bun:test';
import { handleCommand } from '../src/commands.js';

type App = Parameters<typeof handleCommand>[1];
function fixture(released = 1) {
  const calls: unknown[][] = [];
  const framework = {
    getAllAgents: () => [{ name: 'fallback', state: { status: 'waiting_for_tools' } }],
    releaseCodeExecutionWait: (...args: unknown[]) => { calls.push(args); return { released }; },
    abortInference: () => { throw new Error('must not abort'); },
    puppetToolCall: () => { throw new Error('must not inject agent tool calls'); },
  };
  return { app: { framework, agentName: 'prime' } as unknown as App, framework, calls };
}
const text = (result: ReturnType<typeof handleCommand>) => result.lines.map(l => l.text).join('\n');

describe('admin /release-wait', () => {
  test('rejects default IPC/fleet provenance, read-only provenance and arguments claiming admin', () => {
    const f = fixture();
    expect(text(handleCommand('/release-wait', f.app))).toContain('admin-only');
    expect(text(handleCommand('/release-wait', f.app, { admin: false }))).toContain('admin-only');
    expect(text(handleCommand('/release-wait --admin', f.app))).toContain('admin-only');
    expect(f.calls).toEqual([]);
  });
  test('admin can release the blocked agent without knowing a script id', () => {
    const f = fixture();
    expect(text(handleCommand('/release-wait', f.app, { admin: true }))).toContain('completion wakes remain armed');
    expect(f.calls).toEqual([['prime', undefined]]);
  });
  test('supports selecting one script and the UI fallback agent', () => {
    const f = fixture();
    delete f.app.agentName;
    handleCommand('/release-wait py-7', f.app, { admin: true });
    expect(f.calls).toEqual([['fallback', 'py-7']]);
  });
  test('idle or completed observations are an explicit no-op', () => {
    const f = fixture(0);
    expect(text(handleCommand('/release-wait', f.app, { admin: true }))).toContain('No active code wait');
  });
  test('older frameworks fail explicitly without cancellation fallback', () => {
    const f = fixture();
    delete (f.framework as Partial<typeof f.framework>).releaseCodeExecutionWait;
    expect(text(handleCommand('/release-wait', f.app, { admin: true }))).toContain('requires an agent-framework version');
    expect(f.calls).toEqual([]);
  });
  test('rejects extra ids and reports framework ownership errors', () => {
    const f = fixture();
    expect(text(handleCommand('/release-wait py-1 py-2', f.app, { admin: true }))).toContain('Usage:');
    expect(f.calls).toEqual([]);
    f.framework.releaseCodeExecutionWait = () => { throw new Error('No script for owner'); };
    expect(text(handleCommand('/release-wait py-1', f.app, { admin: true }))).toContain('No script for owner');
  });
});
