import { expect, test } from 'bun:test';
import { buildQuotaSnapshot, type PanelAppRef } from '../src/web/panel-data.js';

// No local quota meter: a pay-per-token host shows its dollar estimate, but a
// subscription read nowhere locally (openai-codex through an inference
// gateway, which tracks the windows per login) must not present it as spend.
const app = (extra: Partial<PanelAppRef>): PanelAppRef =>
  ({ framework: {} as PanelAppRef['framework'], recipe: { agent: {} } as PanelAppRef['recipe'], ...extra });

test('no meter on a pay-per-token host: not a subscription', async () => {
  expect(await buildQuotaSnapshot(app({}))).toEqual({ subscription: false, windows: [] });
});

test('no meter on a gateway-held subscription: still a subscription, no windows', async () => {
  expect(await buildQuotaSnapshot(app({ quotaMeter: null, subscriptionUnmetered: true }))).toEqual({ subscription: true, windows: [] });
});
