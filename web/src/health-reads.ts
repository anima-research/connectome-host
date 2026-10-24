/**
 * The order of the page's /healthz reads (web/src/App.tsx). Reads overlap:
 * the 15 s poll, the reread after a command, a forced read (Health's
 * Refresh, a change of the scope Health shows, an observer's
 * acknowledgement), and, while Health inspects a fleet child, that child's
 * read beside the local one. Each is numbered as it starts.
 *
 * Two things follow that order. Whether the page's grant lets it read
 * /healthz: the host checks the same grant for a child's read as for the
 * local one (passedGrant). A refusal loadHealth meets, of either scope,
 * stops the page's reads, unless a read numbered after it has already
 * passed the grant, and such a read answering after the refusal starts them
 * again. The local alert read (reconcileLocalAlerts) counts a read that
 * passed, and leaves a refusal to loadHealth's next read, which meets the
 * same grant. And which local snapshot the page shows: the banner, Health
 * and the alert strip take the newest local read that answered with one. A
 * child's snapshot and a failed read's error aren't ordered.
 */

/** Whether a /healthz answer passed the grant check. The host checks the
 *  grant before anything else can fail (src/modules/web-ui-module.ts: the
 *  route's grant ahead of the fleet child's proxy and of the read's own
 *  503, 500 or panel error), so every status the host answers but 401 and
 *  403 says the grant holds, a failed read's included. A proxy in front of
 *  the host can answer 502 or 504 with no grant checked; that counts as a
 *  pass too, which lets the next read go out, and a refusal then stops the
 *  reads again. */
export const passedGrant = (status: number): boolean => status !== 401 && status !== 403;
export class HealthReads {
  private asked = 0;
  /** The read whose answer last said whether the grant holds. */
  private grantWord = 0;
  /** The newest local read whose snapshot the page took. */
  private localTaken = 0;
  /** Whether the newest word on the grant was a refusal. */
  denied = false;

  /** Number a read as it starts. */
  ask(): number {
    return ++this.asked;
  }

  /** A read refused for its grant (401 or 403): whether it's the newest word
   *  on the grant, which stops the reads. */
  refused(read: number): boolean {
    if (read < this.grantWord) return false;
    this.grantWord = read;
    this.denied = true;
    return true;
  }

  /** A read of any scope that passed the grant (passedGrant), whatever else
   *  it answered: newer than the refusal that stopped the reads, it starts
   *  them again. */
  answered(read: number): void {
    if (read < this.grantWord) return;
    this.grantWord = read;
    this.denied = false;
  }

  /** A local read that went through: whether its snapshot is the one to
   *  show, being newer than every local one taken. */
  takeLocal(read: number): boolean {
    if (read < this.localTaken) return false;
    this.localTaken = read;
    return true;
  }
}
