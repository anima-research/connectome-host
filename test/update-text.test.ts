/**
 * The host update's words as the Web UI shows them (src/web/update-text.ts):
 * the banner's state and buttons, the ways Health offers, the Restart
 * dialog's text, and each way named by its button where `/update` names its
 * command.
 */
import { describe, expect, test } from 'bun:test';
import {
  COMMAND_WAYS, PAGE_WAYS, bannerOf, busyLines, commandFor, dialogStill, goBackLines, keptDismissal, noticeLines, openWays,
  restartLines, shownBanner, statusLines,
  type ReadCheck, type RestartState, type SwitchOutcome, type UpdateStatus,
} from '../src/web/update-text.js';

const base: UpdateStatus = {
  running: '0.12.1', install: true, checks: true, check: null, installing: null, lastInstall: null, installed: null,
  goBack: null, restart: null, operatorQuiesced: null, switchQuiesceLeft: false, lastSwitch: null, problems: [],
};

/** A read that found 0.13.1, crossing 0.12.2 (breaking), 0.13.0 (a cache
 *  write) and 0.13.1 (cut before releases recorded their cost). */
const read: ReadCheck = {
  at: '2026-10-24T05:00:00.000Z', ok: true, candidate: '0.13.1', bunFloorUnmet: null, runningDeprecated: null,
  costs: [
    { version: '0.12.2', breaking: true, cacheWrite: false },
    { version: '0.13.0', breaking: false, cacheWrite: true },
    { version: '0.13.1', breaking: null, cacheWrite: null },
  ],
};

const busy: RestartState = {
  to: '0.13.0', why: 'update', keepData: false, phase: 'busy',
  hosts: [{ host: 'this host', answered: true, drained: false, activeTurnAgents: ['alice'], backgroundScripts: 0 }],
};

const fellBack: SwitchOutcome = {
  outcome: 'fell-back', from: '0.12.1', to: '0.13.0', at: '2026-10-24T04:00:00.000Z', reason: 'its recipe failed to load',
  trialLog: ['loading the recipe', '', 'Error: no such recipe'],
};

describe('the banner', () => {
  test('a restart waiting on turns offers waiting and resuming, points to Health for stopping now, and stays', () => {
    expect(bannerOf({ ...base, installed: '0.13.0', restart: busy })).toEqual({
      line: 'The restart to 0.13.0 is waiting on turns to end, with new turns held. Health says who was busy when its ' +
        'wait ran out, beside Stop now.',
      ways: ['wait', 'resume'],
      dismissable: false,
    });
  });

  test('a restart in any other phase, or a quiesce left standing, says so and stays', () => {
    expect(bannerOf({ ...base, restart: { ...busy, phase: 'quiescing' } }))
      .toEqual({ line: 'The restart to 0.13.0 is waiting for turns to end, with new turns held.', ways: [], dismissable: false });
    expect(bannerOf({ ...base, restart: { ...busy, phase: 'stopping' } })?.ways).toEqual([]);
    // A Go back is named as one, waiting on turns too.
    expect(bannerOf({ ...base, restart: { ...busy, to: '0.12.0', why: 'go-back', phase: 'ending' } })?.line)
      .toBe("The Go back to 0.12.0 is being called off, ending the switch's quiesce.");
    const goingBack: RestartState = { ...busy, to: '0.12.0', why: 'go-back' };
    expect(bannerOf({ ...base, restart: goingBack })?.line).toStartWith('The Go back to 0.12.0 is waiting on turns to end');
    expect(statusLines({ ...base, restart: goingBack })).toContain('The Go back to 0.12.0 is waiting on turns to end, with new ' +
      'turns held. Busy when its wait ran out:');
    expect(busyLines(goingBack, 120_000)[0]).toBe("Turns didn't all end within 2 min, so the Go back to 0.12.0 is waiting, " +
      'with new turns held. Still busy:');
    // Ahead of an install under way, an installed release and a newer one out.
    expect(bannerOf({ ...base, check: read, installing: '0.13.1', installed: '0.13.0', switchQuiesceLeft: true })).toEqual({
      line: "This host is quiesced for a switch that isn't going ahead.", ways: ['resume'], dismissable: false,
    });
  });

  test('an install under way, then an installed release, then a failed install, then a release that is out', () => {
    const all: UpdateStatus = {
      ...base, check: read, installing: '0.13.1', installed: '0.13.0',
      lastInstall: { version: '0.13.1', at: '2026-10-24T05:01:00.000Z', ok: false, error: 'npm exited 1' },
    };
    expect(bannerOf(all)).toEqual({ line: 'Installing 0.13.1.', ways: [], dismissable: false });
    expect(bannerOf({ ...all, installing: null })).toEqual({ line: '0.13.0 is installed.', ways: ['restart'], dismissable: true });
    expect(bannerOf({ ...all, installing: null, installed: null }))
      .toEqual({ line: 'Last install: npm exited 1', ways: ['install'], dismissable: true });
    // Offered again only as a fresh release would be: not when this Bun is too old for it, or nothing newer was read.
    expect(bannerOf({ ...all, installing: null, installed: null, check: { ...read, bunFloorUnmet: '>=1.5.0' } })?.ways).toEqual([]);
    expect(bannerOf({ ...all, installing: null, installed: null, check: null })?.ways).toEqual([]);
    expect(bannerOf({ ...base, check: read })).toEqual({
      line: "connectome-host 0.13.1 is out; this host runs 0.12.1. Breaking: 0.12.2. Read its notes before updating. Each " +
        "resident's prompt cache is written in full once: 0.13.0. Cut before releases recorded what they cost, so read " +
        'their notes: 0.13.1.',
      ways: ['install'],
      dismissable: true,
    });
  });

  test('an installed release whose last try fell back, or whose last request was refused, says so', () => {
    expect(bannerOf({ ...base, installed: '0.13.0', lastSwitch: fellBack })?.line)
      .toBe('0.13.0 ended before its commit at its last try, so 0.12.1 came back. Health shows what it wrote last.');
    // A trial that kept no lines points at the service's log instead.
    expect(bannerOf({ ...base, installed: '0.13.0', lastSwitch: { ...fellBack, trialLog: null } })?.line)
      .toBe("0.13.0 ended before its commit at its last try, so 0.12.1 came back. The service's log, or the terminal the " +
        'host was started in, says more.');
    const refused: SwitchOutcome = {
      outcome: 'refused', step: 'children-check', from: '0.12.1', to: '0.13.0', at: '2026-10-24T04:00:00.000Z',
      reason: 'fleet children are still running: kid',
    };
    expect(bannerOf({ ...base, installed: '0.13.0', lastSwitch: refused })?.line)
      .toBe("0.13.0 is installed, and the last request to switch to it didn't go ahead: fleet children are still running: kid.");
    // About another release, they say nothing of this one.
    expect(bannerOf({ ...base, installed: '0.13.1', lastSwitch: fellBack })?.line).toBe('0.13.1 is installed.');
    expect(bannerOf({ ...base, installed: '0.13.1', lastSwitch: refused })?.line).toBe('0.13.1 is installed.');
  });

  test('a release this Bun is too old for, or a host that cannot update itself, offers no Update', () => {
    const floor = bannerOf({ ...base, check: { ...read, bunFloorUnmet: '>=1.5.0' } });
    expect(floor?.ways).toEqual([]);
    expect(floor?.line).toContain('0.13.1 needs Bun >=1.5.0: upgrade Bun first, and Update installs nothing until then.');
    const notInstall = bannerOf({ ...base, install: false, check: read });
    expect(notInstall?.ways).toEqual([]);
    expect(notInstall?.line).toContain("This host wasn't started through an install's entry point");
  });

  test('a deprecated running release says so, beside a newer release or alone, and nothing else shows no banner', () => {
    expect(bannerOf({ ...base, check: { ...read, runningDeprecated: 'use 0.12.2' } })?.line)
      .toContain('this host runs 0.12.1. 0.12.1 is deprecated on npm (use 0.12.2). Breaking: 0.12.2.');
    expect(bannerOf({ ...base, check: { ...read, candidate: null, costs: [], runningDeprecated: 'use 0.12.2' } }))
      .toEqual({ line: '0.12.1 is deprecated on npm (use 0.12.2).', ways: [], dismissable: true });
    expect(bannerOf({ ...base, check: { ...read, candidate: null, costs: [] } })).toBeNull();
    expect(bannerOf({ ...base, check: { at: read.at, ok: false, error: 'offline' } })).toBeNull();
    expect(bannerOf(base)).toBeNull();
  });
});

describe('a dismissed banner', () => {
  test('stays hidden until the banner says something else, then lapses, and a banner that holds turns never hides', () => {
    const out: UpdateStatus = { ...base, check: read };
    const line = bannerOf(out)!.line;
    expect(shownBanner(out, line)).toBeNull();
    expect(keptDismissal(out, line)).toBe(line);
    // The banner says something else, and the dismissal lapses, so the line shows when it comes back.
    const installed: UpdateStatus = { ...out, installed: '0.13.1' };
    expect(shownBanner(installed, line)?.line).toBe('0.13.1 is installed.');
    expect(keptDismissal(installed, line)).toBeNull();
    expect(shownBanner(out, keptDismissal(installed, line))?.line).toBe(line);
    expect(keptDismissal(null, line)).toBeNull();
    const waiting: UpdateStatus = { ...out, restart: busy };
    expect(shownBanner(waiting, bannerOf(waiting)!.line)).toEqual(bannerOf(waiting));
    expect(shownBanner(null, null)).toBeNull();
  });
});

describe('the ways Health offers', () => {
  test('each way the status leaves open, and only Check now on a host that cannot update itself', () => {
    expect(openWays({ ...base, check: read })).toEqual(['install', 'check']);
    // The release read is the one installed, as after an install that went through.
    expect(openWays({ ...base, check: read, installed: '0.13.1', goBack: { to: '0.12.0', since: 'then' },
      lastInstall: { version: '0.13.1', at: read.at, ok: true } })).toEqual(['restart', 'back', 'check']);
    // A newer release than the installed one is out, and a quiesce was left standing.
    expect(openWays({ ...base, check: read, installed: '0.13.0', switchQuiesceLeft: true }))
      .toEqual(['resume', 'install', 'restart', 'check']);
    expect(openWays({ ...base, check: { ...read, bunFloorUnmet: '>=1.5.0' } })).toEqual(['check']);
    expect(openWays({ ...base, check: { ...read, candidate: null, costs: [] } })).toEqual(['check']);
    // Nothing read, as with the reads off or a failed one: Check now reads, and a failed install offers no blind retry.
    expect(openWays({ ...base, lastInstall: { version: '0.13.1', at: read.at, ok: false, error: 'npm exited 1' } }))
      .toEqual(['check']);
    expect(openWays({ ...base, check: { at: read.at, ok: false, error: 'offline' } })).toEqual(['check']);
    expect(openWays({ ...base, install: false, check: read })).toEqual(['check']);
  });

  test('a restart under way offers its three ways while waiting on turns, and nothing else meanwhile', () => {
    const all: UpdateStatus = { ...base, check: read, installed: '0.13.0', goBack: { to: '0.12.0', since: 'then' } };
    expect(openWays({ ...all, restart: busy })).toEqual(['wait', 'now', 'resume']);
    expect(openWays({ ...all, restart: { ...busy, phase: 'ending' } })).toEqual([]);
    expect(openWays({ ...all, installing: '0.13.1' })).toEqual([]);
    // A quiesce left standing holds new turns, so Resume stays while an install runs.
    expect(openWays({ ...all, installing: '0.13.1', switchQuiesceLeft: true })).toEqual(['resume']);
  });
});

describe('the Restart dialog', () => {
  test('says what the releases up to the installed one cost, from the last read', () => {
    expect(restartLines({ ...base, check: read, installed: '0.13.0' })).toEqual([
      'Restart onto 0.13.0: new turns are held, and turns in progress get up to 2 min to end. If they do, the host ' +
        "stops, and its next start switches to 0.13.0. If they don't, Health lists who is busy, beside Wait longer, Stop " +
        'now and Resume.',
      'Breaking: 0.12.2. Read its notes before updating.',
      "Each resident's prompt cache is written in full once: 0.13.0.",
      'Notes: https://github.com/anima-research/connectome-host/blob/v0.13.0/CHANGELOG.md',
    ]);
  });

  test("says the costs weren't read when the installed release is past the last read, or the read failed", () => {
    const unread = "What the releases up to 0.13.2 cost wasn't read from the registry, so read the notes before restarting.";
    expect(restartLines({ ...base, check: read, installed: '0.13.2' })?.[1]).toBe(unread);
    expect(restartLines({ ...base, check: { at: read.at, ok: false, error: 'offline' }, installed: '0.13.2' })?.[1]).toBe(unread);
    expect(restartLines({ ...base, installed: '0.13.2' })?.[1]).toBe(unread);
  });

  test('says a retry is one, and that an operator quiesce comes back; with nothing installed there is no dialog', () => {
    const lines = restartLines({ ...base, check: read, installed: '0.13.0', lastSwitch: fellBack, operatorQuiesced: 'maintenance' });
    expect(lines).toContain('Its last try ended before its commit: Health shows what 0.13.0 wrote last.');
    expect(lines).toContain('This host is quiesced (maintenance), and comes back quiesced.');
    expect(restartLines({ ...base, check: read, installed: '0.13.0', lastSwitch: { ...fellBack, trialLog: ['', ''] } }))
      .toContain("Its last try ended before its commit. The service's log, or the terminal the host was started in, says more.");
    // A last request to it that didn't go ahead says why, as the banner does.
    const refused: SwitchOutcome = {
      outcome: 'refused', step: 'copy', from: '0.12.1', to: '0.13.0', at: read.at, reason: 'the copy failed: ENOSPC',
    };
    expect(restartLines({ ...base, check: read, installed: '0.13.0', lastSwitch: refused }))
      .toContain("The last request to switch to 0.13.0 didn't go ahead: the copy failed: ENOSPC");
    expect(restartLines({ ...base, check: read, installed: '0.13.1', lastSwitch: refused })?.join('\n')).not.toContain('last request');
    // A fallback from another release says nothing of this one's last try.
    expect(restartLines({ ...base, check: read, installed: '0.13.1', lastSwitch: fellBack })?.join('\n')).not.toContain('last try');
    expect(restartLines({ ...base, check: read })).toBeNull();
  });
});

describe('each way named as its caller names it', () => {
  test("the page names its buttons where /update names its commands", () => {
    const status: UpdateStatus = {
      ...base, check: read, installed: '0.13.0', goBack: { to: '0.12.0', since: '2026-10-20T10:00:00.000Z' },
      lastSwitch: fellBack, switchQuiesceLeft: true,
    };
    const page = statusLines(status, PAGE_WAYS);
    expect(page).toContain('To take it: Update, then Restart.');
    expect(page).toContain('0.13.0 is installed, and ended before its commit at its last try: Restart tries it again.');
    expect(page).toContain('Going back to 0.12.0 is offered, with the copy of its data taken 2026-10-20T10:00:00.000Z: ' +
      'Go back says what each way does.');
    expect(page).toContain("This host is quiesced for a switch that isn't going ahead: Resume ends it.");
    expect(page.join('\n')).not.toContain('/update');
    expect(statusLines(status)).toContain('To take it: /update install, then /update restart.');
    expect(noticeLines(read, '0.12.1', true, PAGE_WAYS).at(-1)).toBe('To take it: Update, then Restart.');
    const back = goBackLines(status, PAGE_WAYS);
    expect(back[1]).toStartWith('- Keep the newer data: 0.12.0 runs on the data as it is now');
    expect(back[1]).toEndWith('and Restore the copy is the way then.');
    expect(back[2]).toStartWith('- Restore the copy: the copy is restored');
    expect(statusLines({ ...status, restart: busy }, PAGE_WAYS)).toContain('Wait longer, Stop now or Resume.');
  });

  test("a restart's answer when turns don't end names the three commands", () => {
    expect(busyLines(busy, 120_000)).toEqual([
      "Turns didn't all end within 2 min, so the restart to 0.13.0 is waiting, with new turns held. Still busy:",
      '- this host: mid-turn: alice',
      '/update restart wait waits up to 10 min more, /update restart now cuts those off and stops, and /update ' +
        'restart resume calls the restart off, to try later.',
    ]);
  });

  test('a trial log keeps its blank lines', () => {
    const lines = statusLines({ ...base, lastSwitch: fellBack });
    expect(lines.slice(-3)).toEqual(['  loading the recipe', '  ', '  Error: no such recipe']);
  });

  test('an open dialog stays while its way is open, and closes once it isn\'t or the section goes', () => {
    const open: UpdateStatus = { ...base, installed: '0.13.0', goBack: { to: '0.12.0', since: 'then' } };
    expect(dialogStill('restart', open)).toBe('restart');
    expect(dialogStill('back', open)).toBe('back');
    expect(dialogStill(null, open)).toBeNull();
    expect(dialogStill('restart', { ...open, installed: null })).toBeNull();
    expect(dialogStill('back', { ...open, goBack: null })).toBeNull();
    expect(dialogStill('restart', { ...open, installing: '0.13.1' })).toBeNull();
    expect(dialogStill('back', { ...open, restart: busy })).toBeNull();
    expect(dialogStill('restart', null)).toBeNull();
  });

  test('a page sends each way as its command, Restart and Go back naming the release it showed', () => {
    const shown: UpdateStatus = { ...base, installed: '0.13.0', goBack: { to: '0.12.0', since: 'then' } };
    expect(commandFor('restart', shown)).toBe('/update restart 0.13.0');
    expect(commandFor('keep', shown)).toBe('/update back keep 0.12.0');
    expect(commandFor('restore', shown)).toBe('/update back restore 0.12.0');
    expect(commandFor('install', shown)).toBe('/update install');
    expect(commandFor('now', shown)).toBe('/update restart now');
    expect(commandFor('check', shown)).toBe('/update');
    expect(commandFor('restart', base)).toBeNull();
    expect(commandFor('keep', base)).toBeNull();
  });

  test('both tables name the same ways', () => {
    // Each command is one /update routes (update-host-update.test.ts, "/update").
    expect(Object.keys(PAGE_WAYS)).toEqual(Object.keys(COMMAND_WAYS));
  });
});
