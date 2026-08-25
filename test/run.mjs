#!/usr/bin/env node
// End-to-end tests for ccfind. No dependencies, no network, no fixtures.
//
// Everything runs against a corpus this script writes into its own mkdtemp
// directory, with CCFIND_CONFIG_DIR pointed at it, so the real transcripts in
// ~/.claude/projects and the real index in ~/.claude/ccfind are never read and
// never written. The `open` tests use stub scripts on a PATH that holds nothing
// else, so no terminal emulator is ever actually launched.
//
//   node test/run.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'skills', 'ccfind', 'scripts', 'ccfind.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfind-test-'));
const CONFIG = path.join(ROOT, '.claude');
const STUBS = path.join(ROOT, 'stubs');

// A test that writes to the real config directory would destroy the user's
// index, so refuse to run unless the target really is a throwaway.
if (!fs.realpathSync(ROOT).startsWith(fs.realpathSync(os.tmpdir()))) {
  console.error('test: refusing to run outside the temp directory');
  process.exit(1);
}

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(detail ? `${name}\n    ${String(detail).replace(/\n/g, '\n    ')}` : name);
}
function eq(name, got, want) {
  ok(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// ------------------------------------------------------------------ the corpus

const DAY = 86400000;
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

function write(project, id, entries) {
  const dir = path.join(CONFIG, 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// A session with a title, N user turns, and one tool call with its output.
function session({ project, id, title, cwd, turns, at, tool }) {
  const base = { sessionId: id, cwd, gitBranch: 'main', version: '2.0.31', userType: 'external', isSidechain: false };
  const out = [{ type: 'ai-title', aiTitle: title, sessionId: id }];
  turns.forEach(([ask, say], i) => {
    const ts = iso(at - i * 60000);
    out.push({ ...base, type: 'user', uuid: `u${i}`, parentUuid: null, timestamp: ts,
      message: { role: 'user', content: [{ type: 'text', text: ask }] } });
    out.push({ ...base, type: 'assistant', uuid: `a${i}`, parentUuid: `u${i}`, timestamp: ts,
      message: { role: 'assistant', content: [{ type: 'text', text: say }] } });
  });
  if (tool) {
    const ts = iso(at);
    out.push({ ...base, type: 'assistant', uuid: 'tc', parentUuid: 'u0', timestamp: ts,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: tool[0] } }] } });
    out.push({ ...base, type: 'user', uuid: 'tr', parentUuid: 'tc', timestamp: ts,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: tool[1] }] }] } });
  }
  return out;
}

const RECENT = '11111111-1111-4111-8111-111111111111';
const MID = '22222222-2222-4222-8222-222222222222';
const OLD = '33333333-3333-4333-8333-333333333333';
const TITLED = '44444444-4444-4444-8444-444444444444';
const INJECT = '55555555-5555-4555-8555-555555555555';

write('-home-dev-web', RECENT, session({
  project: '-home-dev-web', id: RECENT, title: 'zorblatt rollout', cwd: '/home/dev/web',
  at: 3600000,
  turns: [['the zorblatt handler drops every second request', 'the retry budget is exhausted before the second attempt'],
          ['does raising the budget help', 'it does, three retries is enough'],
          ['ship it', 'deployed']],
  tool: ['kubectl logs zorblatt-0', 'quibbleflux timeout after 30s'],
}));

write('-home-dev-api', MID, session({
  project: '-home-dev-api', id: MID, title: 'zorblatt schema', cwd: '/home/dev/api',
  at: 3 * DAY,
  turns: [['zorblatt column type is wrong in the migration', 'it needs bigint, not int']],
}));

write('-home-dev-api', OLD, session({
  project: '-home-dev-api', id: OLD, title: 'zorblatt origins', cwd: '/home/dev/api',
  at: 100 * DAY,
  turns: [['where did the name zorblatt come from', 'a placeholder nobody renamed']],
}));

// Title only, no conversation: the index has to invent one exchange for it, and
// that is exactly the bookkeeping the per-file exchange slice has to get right.
write('-home-dev-web', TITLED, [{ type: 'ai-title', aiTitle: 'titleonlyxyz notes', sessionId: TITLED }]);

write('-home-dev-web', INJECT, session({
  project: '-home-dev-web', id: INJECT, title: 'injected context', cwd: '/home/dev/web',
  at: 7200000,
  turns: [['<system-reminder>secretreminderword</system-reminder>\n<command-args>keepthisword</command-args> what broke',
           'nothing broke']],
}));

// ------------------------------------------------------------------ the runner

const BASE_ENV = { ...process.env, CCFIND_CONFIG_DIR: CONFIG, CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };
delete BASE_ENV.TMUX;
delete BASE_ENV.TERMINAL;

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...BASE_ENV, ...env }, encoding: 'utf8', timeout: 60000,
  });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}
function json(args, env = {}) {
  const r = run([...args, '--json'], env);
  try { return { ...r, j: JSON.parse(r.out) }; } catch { return { ...r, j: null }; }
}
const ids = (res) => (res.j ? res.j.hits.map((h) => h.session) : []);
const list = (res) => ids(res).sort().join(',');

// ------------------------------------------------------------------ index

let r = run(['index']);
eq('index exits 0', r.status, 0);
ok('index reports the corpus', /indexed 5 sessions/.test(r.err), r.err);

r = run(['index']);
ok('second index is a no-op', /up to date \(5 transcripts\)/.test(r.err), r.err);

r = json(['stats']);
eq('stats sees every transcript', r.j && r.j.transcripts, 5);
eq('stats counts titles', r.j && r.j.titled, 5);

// ------------------------------------------------------------------ searching

r = json(['search', 'zorblatt', '--all']);
eq('a rare word finds every session that used it', ids(r).sort().join(','), [RECENT, MID, OLD].sort().join(','));

r = json(['search', 'zorblatt handler drops every second request']);
eq('the best match ranks first', ids(r)[0], RECENT);

r = json(['search', 'quibbleflux']);
eq('tool output is searchable', list(r), RECENT);
eq('the hit names the field it landed in', r.j.hits[0].field, 'output');

r = json(['search', 'quibbleflux', '--field', 'prompt']);
eq('--field restricts to that field', ids(r).length, 0);

r = json(['search', 'titleonlyxyz']);
eq('a title-only session is findable', list(r), TITLED);
eq('a title-only session reports one turn', r.j.hits[0].turns, 1);

r = json(['search', 'zorblatt', '--session', RECENT.slice(0, 8), '--all']);
eq('--session takes an id prefix', list(r), RECENT);

r = json(['search', 'zorblatt', '--project', 'api', '--all']);
eq('--project filters by directory', ids(r).sort().join(','), [MID, OLD].sort().join(','));

r = json(['search', 'zorblatt', '--exclude', MID, '--all']);
ok('--exclude drops the session', !ids(r).includes(MID), ids(r).join(','));

r = json(['search', 'zorblatt', '--all'], { CLAUDE_CODE_SESSION_ID: RECENT });
ok('the searching session excludes itself', !ids(r).includes(RECENT), ids(r).join(','));
r = json(['search', 'zorblatt', '--all', '--self'], { CLAUDE_CODE_SESSION_ID: RECENT });
ok('--self puts it back', ids(r).includes(RECENT), ids(r).join(','));

r = json(['search', 'zorblatt', '--group', 'exchange', '--all']);
ok('--group exchange hits turns, not sessions', r.j && r.j.group === 'exchange' && r.j.hits.length >= 3, r.out.slice(0, 200));

r = json(['search', 'zorblatt']);
const gated = r.j;
r = json(['search', 'zorblatt', '--all']);
ok('the relevance gate hides weak hits', gated.hits.length <= r.j.hits.length, `${gated.hits.length} > ${r.j.hits.length}`);
eq('gated and ungated agree on the total', gated.total, r.j.total);
ok('the top hit always survives the gate', gated.hits.length >= 1, JSON.stringify(gated));

eq('a query that matches nothing is empty, not an error', json(['search', 'nothinglikethis']).j.hits.length, 0);
eq('an empty result still carries the group key', json(['search', 'nothinglikethis']).j.group, 'session');

// ------------------------------------------------------- injected context

eq('injected context is not indexed', json(['search', 'secretreminderword']).j.hits.length, 0);
eq('slash-command arguments survive the wrapper', list(json(['search', 'keepthisword'])), INJECT);

// ------------------------------------------------------------------ turns

r = json(['search', 'zorblatt', '--session', RECENT.slice(0, 8), '--all']);
eq('turns counts the user prompts', r.j.hits[0].turns, 3);
r = json(['search', 'zorblatt', '--session', MID.slice(0, 8), '--all']);
eq('a one-question session reports one turn', r.j.hits[0].turns, 1);

// ------------------------------------------------------------------ --days

const days = (v) => ids(json(['search', 'zorblatt', '--all', ...(v === null ? ['--days'] : ['--days', v])])).sort().join(',');
eq('--days 2 keeps only the recent session', days('2'), RECENT);
eq('--days 5 reaches the three-day-old one', days('5'), [RECENT, MID].sort().join(','));
eq('--days 400 reaches all of them', days('400'), [RECENT, MID, OLD].sort().join(','));
eq('--days 0.5 is half a day, not zero days', days('0.5'), RECENT);
eq('a bare --days means one day', days(null), RECENT);
eq('--days abc filters nothing instead of matching nothing', days('abc'), [RECENT, MID, OLD].sort().join(','));
eq('--days -3 filters nothing instead of matching nothing', days('-3'), [RECENT, MID, OLD].sort().join(','));
r = json(['search', 'zorblatt', '--days', 'abc']);
ok('a rejected --days says so on stderr', /ignoring --days abc/.test(r.err), r.err);
ok('the warning stays out of stdout', r.j !== null, r.out.slice(0, 120));

// ------------------------------------------------------------------ show

r = json(['show', RECENT.slice(0, 8)]);
eq('show finds the session by prefix', r.j && r.j.session, RECENT);
eq('show counts every turn', r.j && r.j.turns, 3);
eq('show lists every turn', r.j && r.j.shown.length, 3);
ok('show keeps the turns in order', r.j.shown[0].prompt.includes('drops every second request'), JSON.stringify(r.j.shown[0]));
eq('show refuses an unknown id', run(['show', 'ffffffff']).status, 1);

// ------------------------------------------------------------------ pick

// Nothing here is a tty, which is the case pick has to handle without pretending
// it can read arrow keys: it prints the list and the commands instead.
r = run(['pick', 'zorblatt']);
eq('pick without a tty exits 0', r.status, 0);
ok('pick without a tty prints the list', /zorblatt rollout/.test(r.out), r.out.slice(0, 200));
ok('pick prints whole ids, never a prefix', new RegExp(`/resume ${RECENT}`).test(r.out), r.out.slice(0, 200));
eq('pick refuses an empty query', run(['pick']).status, 1);

// The filter line. CCFIND_PICK_KEYS replays a key script into the same handler a
// terminal drives, so this exercises the real key parsing without a pseudo-tty:
// `\e` is Escape, `\r` is Enter, `\b` is Backspace, `\xNN` is that byte. When the
// script runs out, pick prints the query it ended on and the selected session.
const keys = (script, args = ['pick', 'zorblatt', '--all']) =>
  run(args, { CCFIND_PICK_KEYS: script });

r = keys('/ schema\\r');
eq('a filtered pick exits 0', r.status, 0);
ok('/ opens the filter on the query already showing', /filter: zorblatt schema/.test(r.out), r.out);
ok('typing in the filter re-runs the search', new RegExp(`--resume ${MID}`).test(r.out), r.out);

r = keys('/ schema\\e');
ok('esc puts the old query back', /filter: zorblatt\n/.test(r.out), r.out);

r = run(['pick', 'zorblatt', '--all'], { CCFIND_PICK_KEYS: '/ schema\\r\\r', CCFIND_PICK_DRYRUN: '1' });
eq('enter after the filter opens the session', r.status, 0);
ok('it opens what the filter selected', new RegExp(`claude --resume ${MID}`).test(r.out), r.out);

r = keys('/zzzz');
eq('a filter that matches nothing still exits 0', r.status, 0);
ok('a filter that matches nothing says so', /\(no match\)/.test(r.out), r.out);

// The first Enter commits the unmatched filter, so `jjkk` and the second Enter
// land in the list itself, with nothing in it to move to or open.
r = keys('/zzzz\\rjjkk\\r');
eq('moving with nothing to move to is not an error', r.status, 0);
ok('enter with nothing selected opens nothing', /\(no match\)/.test(r.out), r.out);

r = keys('/zzzz\\b\\b\\b\\b');
ok('backspace brings the hits back', /filter: zorblatt\n/.test(r.out), r.out);
ok('backspace leaves a session selected', /--resume [0-9a-f]/.test(r.out), r.out);

r = keys('/ schema\\x15zorblatt origins');
ok('ctrl-u clears the filter', /filter: zorblatt origins/.test(r.out), r.out);
ok('a cleared filter can be retyped', new RegExp(`--resume ${OLD}`).test(r.out), r.out);

r = keys('/я');
ok('the filter takes non-ascii', /filter: zorblattя/.test(r.out), r.out);

// Moving still works with the filter closed, which is the half of the handler the
// filter had to be threaded through without disturbing.
ok('j and k pick different rows', keys('j').out !== keys('k').out,
   `${keys('j').out}\n--\n${keys('k').out}`);

// ------------------------------------------------------------------ open

const LINUX = process.platform === 'linux';
const DARWIN = process.platform === 'darwin';

r = run(['open', RECENT], { CCFIND_OPEN_DRYRUN: '1' });
const ladder = r.out.trim().split('\n');
ok('every candidate runs the resume command', ladder.every((l) => l.includes('claude --resume')), r.out);
if (LINUX) {
  ok('the ladder starts with the freedesktop dispatcher', /^"xdg-terminal-exec"/.test(ladder[0]), ladder[0]);
  ok('the ladder knows the current GNOME terminal', r.out.includes('"ptyxis"'), r.out);
  // Closing a window is only confirmed when the pty's foreground process group
  // differs from the process the terminal spawned. That needs both halves: the
  // trailing builtin, or the shell execs itself away and `claude` becomes the
  // spawned process; and `set -m`, or `claude` runs in the shell's own group and
  // the two still match. Measured: without job control the child's pgid is the
  // shell's, with it the child leads its own group.
  ok('a Linux window keeps a shell above claude so closing it still prompts',
     ladder.every((l) => /"set -m; cd .*claude --resume [^"]*; exit \$\?"$/.test(l)), r.out);
}
if (DARWIN) ok('the ladder drives the macOS terminal through osascript', r.out.includes('"osascript"'), r.out);
// macOS must NOT get that trailing builtin: `do script` runs the text in a new
// window's interactive shell, so exiting it would close a window that otherwise
// stays at a prompt when claude quits.
if (DARWIN) ok('the macOS command leaves the interactive shell alive',
               !/; exit \$\?/.test(r.out) && !/set -m/.test(r.out), r.out);
ok('a multiplexer wins outright', run(['open', RECENT], { CCFIND_OPEN_DRYRUN: '1', TMUX: 'fake' }).out.trim().split('\n').length === 1);

// The four ways a launch can go, as stub scripts. On Linux the ladder honours
// $TERMINAL, so one directory holding all four is enough. macOS goes through
// osascript and ignores $TERMINAL, so each behaviour needs its own directory
// with an `osascript` in it. Either way PATH holds nothing else, so every real
// emulator in the ladder fails to resolve and no window can open by accident.
const SLEEP = fs.existsSync('/bin/sleep') ? '/bin/sleep' : '/usr/bin/sleep';
// PATH holds the stub directory and nothing else, so anything a stub runs has to
// be named by its absolute path.
const ENVBIN = fs.existsSync('/usr/bin/env') ? '/usr/bin/env' : '/bin/env';
const FLAG = path.join(ROOT, 'child-ran');
// The dump path is baked into the stub rather than passed in the environment,
// because the environment is the thing under test.
const ENVDUMP = path.join(ROOT, 'child-env');
const BEHAVIOURS = {
  'ok-fast': 'exit 0',
  fails: 'exit 1',
  signalled: 'kill -TERM $$',
  foreground: `${SLEEP} 3\necho ran > ${FLAG}`,
  dumpenv: `${ENVBIN} > ${ENVDUMP}\nexit 0`,
};
fs.mkdirSync(path.join(STUBS, 'bin'), { recursive: true });
fs.mkdirSync(path.join(STUBS, 'mac', 'none'), { recursive: true });
for (const [name, body] of Object.entries(BEHAVIOURS)) {
  fs.writeFileSync(path.join(STUBS, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(STUBS, 'mac', name), { recursive: true });
  fs.writeFileSync(path.join(STUBS, 'mac', name, 'osascript'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
const only = (behaviour) => (DARWIN
  ? { PATH: path.join(STUBS, 'mac', behaviour || 'none') }
  : { PATH: path.join(STUBS, 'bin'), ...(behaviour ? { TERMINAL: behaviour } : {}) });
const WINDOW = DARWIN ? 'Terminal' : null;

r = run(['open', RECENT], { ...only('ok-fast'), TERM_PROGRAM: '' });
eq('a terminal that exits 0 counts as opened', r.status, 0);
ok('opening names the terminal', new RegExp(`opened .* in a new ${WINDOW || 'ok-fast'} window`).test(r.out), r.out);

r = run(['open', RECENT], { ...only('fails'), TERM_PROGRAM: '' });
eq('a terminal that exits non-zero is not opened', r.status, 1);
ok('the fallback offers /resume', r.err.includes(`/resume ${RECENT}`), r.err);

r = run(['open', RECENT], { ...only('signalled'), TERM_PROGRAM: '' });
eq('a terminal killed by a signal is not opened', r.status, 1);

r = run(['open', RECENT], { ...only(null), TERM_PROGRAM: '' });
eq('no terminal at all still exits cleanly', r.status, 1);
ok('the fallback offers the raw command', /claude --resume/.test(r.err), r.err);

const t0 = Date.now();
r = run(['open', RECENT], { ...only('foreground'), TERM_PROGRAM: '', CCFIND_OPEN_GRACE_MS: '400' });
const waited = Date.now() - t0;
eq('a foreground terminal counts as opened', r.status, 0);
ok('a foreground terminal does not block until the window closes', waited < 2500, `${waited} ms`);
ok('the terminal outlives the process that started it', !fs.existsSync(FLAG), 'child finished too early to prove anything');

// Claude Code's per-session markers must not reach the window we open, or the
// resumed session inherits `CLAUDE_CODE_CHILD_SESSION`, stops saving its
// transcript, and can never be indexed again. Settings the user chose have to
// survive the same scrub, so both directions are asserted here.
r = run(['open', RECENT], {
  ...only('dumpenv'),
  TERM_PROGRAM: '',
  CLAUDECODE: '1',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_SESSION_ID: 'parent-session-id',
  CLAUDE_CODE_MESSAGING_TOKEN: 'parent-token',
  CLAUDE_CONFIG_DIR: '/nonexistent/kept-by-design',
});
eq('the env-reporting terminal counts as opened', r.status, 0);
const childEnv = fs.existsSync(ENVDUMP) ? fs.readFileSync(ENVDUMP, 'utf8') : '';
ok('the opened window reports an environment at all', /^PATH=/m.test(childEnv), 'no environment was captured');
for (const marker of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
                      'CLAUDE_CODE_MESSAGING_TOKEN']) {
  ok(`${marker} does not leak into the opened window`,
     !new RegExp(`^${marker}=`, 'm').test(childEnv), childEnv);
}
ok('CLAUDE_CONFIG_DIR survives the scrub',
   /^CLAUDE_CONFIG_DIR=\/nonexistent\/kept-by-design$/m.test(childEnv), childEnv);

// ------------------------------------------------------------------ launcher

// `install` is the one thing ccfind writes outside the plugin directory, so it
// gets tested against a throwaway bin directory. CCFIND_BIN_DIR wins over every
// candidate, so the real ~/.local/bin is never a target here.
const BIN = path.join(ROOT, 'bin');
const LINK = path.join(BIN, 'ccfind');
const MARK = 'ccfind launcher (generated by `ccfind install`)';
const inst = (env = {}) => run(['install'], { CCFIND_BIN_DIR: BIN, ...env });

r = inst();
eq('install exits 0', r.status, 0);
ok('install names the file it wrote', r.out.includes(`installed: ${LINK}`), r.out);
ok('the launcher exists', fs.existsSync(LINK), BIN);
ok('the launcher is marked as ours', fs.readFileSync(LINK, 'utf8').includes(MARK), 'no marker');
ok('the launcher is executable', (fs.statSync(LINK).mode & 0o111) !== 0, fs.statSync(LINK).mode.toString(8));

// HOME without a plugin registry, so the launcher takes its fallback path and
// resolves to the script under test rather than to whatever is installed on the
// machine running the suite.
const NOHOME = path.join(ROOT, 'nohome');
fs.mkdirSync(NOHOME, { recursive: true });
r = (() => {
  const x = spawnSync(process.execPath, [LINK, 'search', 'flimberflam', '--json'],
    { env: { ...BASE_ENV, HOME: NOHOME, USERPROFILE: NOHOME }, encoding: 'utf8', timeout: 60000 });
  return { status: x.status, out: x.stdout || '', err: x.stderr || '' };
})();
eq('the launcher runs the CLI', r.status, 0);
ok('the launcher produces real output', /"hits"/.test(r.out), r.out + r.err);

// The PATH advice has to name the startup file the user's own shell reads. A
// bash user sent to ~/.zshrc edits a file that is never sourced, and the command
// still does not exist afterwards.
r = inst({ SHELL: '/usr/bin/zsh' });
ok('zsh gets ~/.zshrc', /~\/\.zshrc && exec zsh/.test(r.out), r.out);
r = inst({ SHELL: '/bin/bash' });
const RC = process.platform === 'darwin' ? '~/.bash_profile' : '~/.bashrc';
ok(`bash gets ${RC}`, r.out.includes(`>> ${RC} && exec bash`), r.out);
ok('bash is never sent to ~/.zshrc', !r.out.includes('.zshrc'), r.out);
r = inst({ SHELL: '/usr/bin/fish' });
ok('fish gets its own builtin', r.out.includes(`fish_add_path ${BIN}`), r.out);
ok('fish gets no export line', !/export PATH/.test(r.out), r.out);
r = inst({ SHELL: '/usr/bin/ksh' });
ok('an unknown shell still gets the line', /export PATH="/.test(r.out), r.out);
ok('an unknown shell is named, not guessed at', /ksh's startup file/.test(r.out), r.out);

r = inst({ PATH: `${BIN}${path.delimiter}${STUBS}` });
ok('a directory already on PATH gets no advice', !/not on your PATH/.test(r.out), r.out);
ok('and gets the command line instead', /run it as: ccfind pick/.test(r.out), r.out);

// Overwriting the user's own file would be destroying something ccfind did not
// create, so both directions refuse.
fs.writeFileSync(LINK, '#!/bin/sh\necho someone elses tool\n', { mode: 0o755 });
r = inst();
eq('install refuses a foreign file', r.status, 1);
ok('and says whose it is not', /was not written by ccfind/.test(r.err), r.err);
r = run(['uninstall'], { CCFIND_BIN_DIR: BIN });
eq('uninstall refuses a foreign file', r.status, 1);
ok('uninstall leaves it in place', fs.existsSync(LINK), 'removed a foreign file');

fs.unlinkSync(LINK);
r = inst();
eq('install works again after the file is gone', r.status, 0);
r = inst();
eq('installing over our own launcher is fine', r.status, 0);
r = run(['uninstall'], { CCFIND_BIN_DIR: BIN });
eq('uninstall exits 0', r.status, 0);
ok('uninstall reports the removal', r.out.includes(`removed ${LINK}`), r.out);
ok('the launcher is gone', !fs.existsSync(LINK), LINK);
r = run(['uninstall'], { CCFIND_BIN_DIR: BIN });
eq('uninstall with nothing to remove is not an error', r.status, 0);
ok('and says so', r.out.includes(`nothing at ${LINK}`), r.out);

// ------------------------------------------------------------------ staleness

fs.appendFileSync(path.join(CONFIG, 'projects', '-home-dev-api', `${MID}.jsonl`),
  JSON.stringify({ sessionId: MID, type: 'user', uuid: 'u9', parentUuid: null, cwd: '/home/dev/api',
    timestamp: iso(3 * DAY), message: { role: 'user', content: [{ type: 'text', text: 'and the flimberwock index too' }] } }) + '\n');
r = run(['index']);
ok('a grown transcript is reindexed', /indexed 5 sessions/.test(r.err), r.err);
eq('the new turn is searchable', list(json(['search', 'flimberwock'])), MID);

// ------------------------------------------------------------------ report

fs.rmSync(ROOT, { recursive: true, force: true });
if (failures.length) {
  console.error(`\n${failures.length} failed, ${pass} passed\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log(`${pass} passed`);
