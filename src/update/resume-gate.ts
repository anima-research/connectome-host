import { ResumeBlockedError, type HostModeStatus } from '@animalabs/agent-framework';
import { switchHold, type SwitchHold } from './quiesce.js';

class SwitchHoldRefusal extends ResumeBlockedError {
  readonly switchHold = true;

  constructor(message: string) {
    super(message, []);
  }
}

/** Put `framework`'s resume behind `hold`, for every door that calls it: a
 *  resume asked while the hold stands throws agent-framework's
 *  ResumeBlockedError with the hold's words and no verdicts, `force` or not,
 *  and one under way is counted for the switch's last look. */
export function gateResume(
  framework: { resume(opts?: { force?: boolean }): Promise<HostModeStatus> }, hold: SwitchHold = switchHold,
): void {
  const resume = framework.resume.bind(framework);
  framework.resume = async (opts) => {
    const asked = await hold.resumeHere(() => resume(opts));
    if ('refused' in asked) throw new SwitchHoldRefusal(asked.refused);
    return asked.done;
  };
}
