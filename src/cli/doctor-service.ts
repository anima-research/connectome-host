import type { ServiceSystem } from './service.js';
import type { ServiceUnits } from './service-unit.js';

export interface ServiceCheck {
  passed: boolean;
  lines: string[];
  stopped?: true;
}

export function checkUnits(units: ServiceUnits, work: string, shell: boolean, cmd: string, sys: ServiceSystem,
  stoppedIsFine = false): ServiceCheck {
  return { passed: false, lines: [`not checked: ${units.host.name} ${work} ${shell} ${cmd} ${sys.home} ${stoppedIsFine}`] };
}

export function servicePid(units: ServiceUnits, sys: ServiceSystem): { pid: string } | { why: string } {
  return { why: `not asked: ${units.host.name} ${sys.home}` };
}
