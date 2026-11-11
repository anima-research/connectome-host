import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './quarantine-fixture.js';
import { runHeadless } from '../src/headless.js';
const fx = await fixture(process.env.DATA_DIR!);
const native = fx.strategy.releaseCompressionRefusalQuarantine.bind(fx.strategy);
fx.strategy.releaseCompressionRefusalQuarantine = async intent => {
  appendFileSync(join(fx.dir,'native-dispatches'), `${JSON.stringify(intent)}\n`);
  const result = await native(intent);
  if (process.env.HOLD_ACK === '1') {
    writeFileSync(join(fx.dir,'landed'), 'yes');
    while (!existsSync(join(fx.dir,'ack'))) await Bun.sleep(10);
  }
  return result;
};
// Synthetic foreground events only: no framework start, inference or provider wake.
const sinks = new Set<Parameters<typeof fx.framework.onTrace>[0]>();
const onTrace = fx.framework.onTrace.bind(fx.framework);
fx.framework.onTrace = (listener, options) => {
  sinks.add(listener);
  const off = onTrace(listener, options);
  return () => { sinks.delete(listener); off(); };
};
process.on('message', events => {
  for (const event of events as Parameters<Parameters<typeof fx.framework.onTrace>[0]>[0][]) {
    for (const sink of sinks) sink(event);
  }
});
await runHeadless(fx.app);
