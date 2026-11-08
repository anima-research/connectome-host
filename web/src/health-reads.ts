/** A proxy in front of the host can answer 502 or 504 with no grant checked;
 *  that counts as a pass too. */
export const passedGrant = (status: number): boolean => status !== 401 && status !== 403;
export class HealthReads {
  private asked = 0;
  private grantWord = 0;
  private localTaken = 0;
  denied = false;

  ask(): number {
    return ++this.asked;
  }

  refused(read: number): boolean {
    if (read < this.grantWord) return false;
    this.grantWord = read;
    this.denied = true;
    return true;
  }

  answered(read: number): void {
    if (read < this.grantWord) return;
    this.grantWord = read;
    this.denied = false;
  }

  takeLocal(read: number): boolean {
    if (read < this.localTaken) return false;
    this.localTaken = read;
    return true;
  }
}
