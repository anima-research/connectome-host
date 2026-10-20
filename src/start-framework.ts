import type { AgentFramework } from '@animalabs/agent-framework';
import { FleetModule } from './modules/fleet-module.js';

/**
 * Start a framework's agents, and only then its fleet's autoStart children.
 * A child is a host with residents of its own, so none of them acts before
 * the parent's agents run. Every place the host starts a framework comes
 * through here: the start in main() and a session switch's.
 */
export function startFramework(framework: Pick<AgentFramework, 'start' | 'getModule'>): void {
  framework.start();
  const fleet = framework.getModule('fleet');
  if (fleet instanceof FleetModule) fleet.launchAutoStart();
}
