import { DEFAULT_HOME_SEND_TIMEOUT_MS } from './modules/notice-home.js';
import { NoticesModule } from './modules/notices-module.js';

export type StoppableFramework = { stop(): Promise<void>; getModule(name: string): unknown };

const DRAIN_TIMEOUT_MS = DEFAULT_HOME_SEND_TIMEOUT_MS + 1000; // Allow a little time for journal I/O.

/** AF stops modules and closes MCP connections in parallel. Give the home a
 * bounded head start while its connector is still open. */
export async function stopFramework(framework: StoppableFramework): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const notices = framework.getModule?.('notices');
    if (notices instanceof NoticesModule) {
      const drained = await Promise.race([
        notices.drainHome().then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS); }),
      ]);
      if (!drained) console.error(`[notices:home] drain before stop timed out after ${DRAIN_TIMEOUT_MS} ms; framework teardown proceeds. A pending write or send is not cancelled by the timeout and may complete or be lost.`);
    }
  } catch (error) {
    console.error(`[notices:home] drain before stop failed: ${error instanceof Error ? error.message : String(error)}; stopping anyway.`);
  } finally {
    clearTimeout(timer);
  }
  // After the ~6 s pre-stop timeout, AF closes MCP connections in parallel
  // with module stops. With no stop budget, framework.stop() still waits
  // for pending journal I/O before shutdown or a session switch can proceed.
  await framework.stop();
}
