import { describe, test, expect, spyOn } from 'bun:test';
import { FleetModule } from '../src/modules/fleet-module.js';
import { startFramework } from '../src/start-framework.js';

describe('startFramework', () => {
  test("starts the framework's agents before its fleet launches any autoStart child", () => {
    const order: string[] = [];
    const fleet = new FleetModule({});
    spyOn(fleet, 'launchAutoStart').mockImplementation(() => { order.push('fleet launches its autoStart children'); });
    // The framework finds a module by its own name, so the fake answers to the fleet's.
    startFramework({
      start: () => { order.push('framework starts its agents'); },
      getModule: (name: string) => (name === fleet.name ? fleet : null),
    });
    expect(order).toEqual(['framework starts its agents', 'fleet launches its autoStart children']);
  });

  test('starts a framework that has no fleet', () => {
    let started = 0;
    startFramework({ start: () => { started++; }, getModule: () => null });
    expect(started).toBe(1);
  });
});
