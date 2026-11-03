import { expect, test } from 'bun:test';
import { buildQuotaSnapshot, type PanelAppRef } from '../src/web/panel-data.js';

const app = (extra: Partial<PanelAppRef>): PanelAppRef =>
  ({ framework: {} as PanelAppRef['framework'], recipe: { agent: {} } as PanelAppRef['recipe'], ...extra });

test('no meter on a pay-per-token host: not a subscription', async () => {
  expect(await buildQuotaSnapshot(app({}))).toEqual({ subscription: false, windows: [] });
});

test('no meter on a gateway-held subscription: still a subscription, no windows', async () => {
  expect(await buildQuotaSnapshot(app({ quotaMeter: null, subscriptionUnmetered: true }))).toEqual({ subscription: true, windows: [] });
});

test('a read that failed with no message still answers with its error', async () => {
  const meter = (error: string | undefined) => ({
    provider: 'anthropic',
    refresh: async () => ({ provider: 'anthropic', windows: [], fetchedAt: 0, ...(error !== undefined ? { error } : {}) }),
    blockedUntil: () => null,
  }) as unknown as NonNullable<PanelAppRef['quotaMeter']>;
  expect(await buildQuotaSnapshot(app({ quotaMeter: meter('') }))).toMatchObject({ subscription: true, error: '' });
  expect(await buildQuotaSnapshot(app({ quotaMeter: meter(undefined) }))).not.toHaveProperty('error');
});
