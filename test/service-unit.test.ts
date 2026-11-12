import { expect, test } from 'bun:test';
import { plist, readUnit, systemdUnit } from '../src/cli/service-unit.js';

const awkward = ['/opt/bun 1/bin/bun', '/srv/a "quoted" dir/start.js', 'C:\\path\\recipe 100%.json',
  'https://example.test/r.json?a=1&b=<2>', '$HOME and $$ and ${X}', "it's", '--headless'];
const work = "/srv/a \"quoted\" dir/100% & <work> it's";
const env: Array<[string, string]> = [['PATH', '/usr/bin:/bin'], ['DATA_DIR', '/srv/data 100%'], ['CONNECTOME_SUPERVISED', '1']];

test('reads back the argv and working directory of a systemd unit written with awkward words in each field', () => {
  for (const wants of [null, 'connectome-shell-x.service']) {
    const text = systemdUnit('connectome-host resident in /srv', work, awkward, env, wants);
    expect(readUnit('systemd-user', text)).toEqual({ argv: awkward, workingDirectory: work });
  }
});

test('reads back the argv and working directory of a launch agent written with awkward words in each field', () => {
  const text = plist('com.connectome.x', work, awkward, env, '/srv/logs/agent 100% & <x>.log');
  expect(readUnit('launchd', text)).toEqual({ argv: awkward, workingDirectory: work });
});

test('a systemd unit whose start or working directory line install could not have written is refused with what is wrong with it', () => {
  const text = systemdUnit('connectome-host resident in /srv', '/srv/w', ['/bin/bun', '/srv/start.js', 'r.json'], env, null);
  const cases: Array<[string, RegExp]> = [
    [text.replace(/^ExecStart=.*\n/m, ''), /ExecStart/],
    [text.replace(/^WorkingDirectory=.*\n/m, ''), /WorkingDirectory/],
    [text.replace(/^ExecStart=.*$/m, 'ExecStart=/bin/bun /srv/start.js r.json'), /ExecStart/],
    [text.replace(/^ExecStart=.*$/m, 'ExecStart="/bin/bun" "/srv/start.js" "r\\n.json"'), /ExecStart/],
    [text.replace(/^ExecStart=.*$/m, 'ExecStart="/bin/bun" "/srv/start.js" "$HOME/r.json"'), /ExecStart/],
    [text.replace(/^WorkingDirectory=.*$/m, 'WorkingDirectory=/srv/%h'), /WorkingDirectory/],
    [`${text}ExecStart="/bin/true"\n`, /ExecStart/],
    [text.replace(/^WorkingDirectory=.*$/m, 'WorkingDirectory=/srv/w\\'), /backslash/],
    [text.replace(/^ExecStart=.*$/m, 'ExecStart="/bin/bun" "/srv/start.js" "r\t.json"'), /ExecStart/],
    [text.replace(/^ExecStart=.*$/m, 'ExecStart="/bin/bun" "/srv/start.js" "r\u0001.json"'), /ExecStart/],
  ];
  for (const [edited, said] of cases) {
    const read = readUnit('systemd-user', edited);
    expect(read).toEqual({ why: expect.stringMatching(said) });
  }
});

test('a launch agent whose start or working directory line install could not have written is refused with what is wrong with it', () => {
  const text = plist('com.connectome.x', '/srv/w', ['/bin/bun', '/srv/start.js', 'r.json'], env, '/srv/agent.log');
  const cases: Array<[string, RegExp]> = [
    [text.replace('  <key>ProgramArguments</key>\n', ''), /ProgramArguments/],
    [text.replace('  <key>WorkingDirectory</key>\n', ''), /WorkingDirectory/],
    [text.replace('<string>r.json</string>', '<string>r&nbsp;.json</string>'), /ProgramArguments/],
    [text.replace('<string>/srv/w</string>', '<string>/srv/<w</string>'), /WorkingDirectory/],
    [text.replace('  </array>\n', ''), /ProgramArguments/],
    [text.replace(/\n {4}<string>/g, '\n\t\t<string>'), /ProgramArguments/],
    [text.replace('<string>r.json</string>', '<string>r\t.json</string>'), /ProgramArguments/],
    [text.replace('<string>r.json</string>', '<string>r\u0001.json</string>'), /ProgramArguments/],
    [text.replace('<string>/srv/w</string>', '<string>/srv/\tw</string>'), /WorkingDirectory/],
  ];
  for (const [edited, said] of cases) {
    const read = readUnit('launchd', edited);
    expect(read).toEqual({ why: expect.stringMatching(said) });
  }
});
