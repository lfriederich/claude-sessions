import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGroups, isInactive, isSessionAlive, parseHistory, parsePpid, parseStartTime, readHistory, readLiveSessions, truncate, formatRelative, LiveSession } from './model';

const live = (o: Partial<LiveSession>): LiveSession => ({ pid: 1, sessionId: 's', cwd: '/p', ...o });

test('parseHistory ignore les lignes invalides', () => {
  const txt = '{"display":"a","timestamp":1,"project":"/p","sessionId":"x"}\nnot json\n{"foo":1}\n';
  const h = parseHistory(txt);
  assert.equal(h.length, 1);
  assert.equal(h[0].display, 'a');
});

test('parsePpid gère un comm avec espaces et parenthèses', () => {
  assert.equal(parsePpid('859 (claude (x) y) S 690 859 690 0 -1'), 690);
  assert.equal(parsePpid('garbage'), undefined);
});

test('parseStartTime lit le champ 22 de /proc/<pid>/stat', () => {
  const stat = '859 (claude (x) y) S 690 859 690 0 -1 4194560 100 0 0 0 5 2 0 0 20 0 11 0 837924 1000 50';
  assert.equal(parseStartTime(stat), '837924');
  assert.equal(parseStartTime('garbage'), undefined);
});

test('isSessionAlive écarte un pid réattribué à un autre processus', () => {
  const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-proc-'));
  fs.mkdirSync(path.join(procRoot, String(process.pid)));
  fs.writeFileSync(path.join(procRoot, String(process.pid), 'stat'), `${process.pid} (node) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 4242 1000 50`);
  assert.equal(isSessionAlive(live({ pid: process.pid, procStart: '4242' }), procRoot), true);
  assert.equal(isSessionAlive(live({ pid: process.pid, procStart: '1111' }), procRoot), false, 'même pid, autre processus');
  assert.equal(isSessionAlive(live({ pid: process.pid }), procRoot), true, 'ancien format sans procStart : le pid fait foi');
  assert.equal(isSessionAlive(live({ pid: process.pid, procStart: '1111' }), path.join(procRoot, 'absent')), true, 'pas de /proc : le pid fait foi');
});

test('readHistory ne relit le fichier que s\'il a changé', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-')), 'history.jsonl');
  const line = (id: string) => JSON.stringify({ display: id, timestamp: 1, project: '/p', sessionId: id }) + '\n';
  fs.writeFileSync(file, line('a'));
  const first = readHistory(file);
  assert.equal(readHistory(file), first, 'fichier inchangé : même résultat, sans relecture');
  fs.appendFileSync(file, line('b'));
  assert.deepEqual(readHistory(file).map((h) => h.sessionId), ['a', 'b']);
});

test('readLiveSessions filtre les pids morts et les fichiers corrompus', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify(live({ pid: 1, sessionId: 'a', cwd: '/a' })));
  fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify(live({ pid: 2, sessionId: 'b', cwd: '/b' })));
  fs.writeFileSync(path.join(dir, '3.json'), '{broken');
  fs.writeFileSync(path.join(dir, 'x.key'), 'secret');
  const res = readLiveSessions(dir, (s) => s.pid === 1);
  assert.deepEqual(res.map((s) => s.sessionId), ['a']);
});

test('buildGroups fusionne live et historique, trie busy > idle > passé', () => {
  const history = parseHistory([
    JSON.stringify({ display: 'premier prompt', timestamp: 100, project: '/p', sessionId: 'old' }),
    JSON.stringify({ display: 'suite', timestamp: 200, project: '/p', sessionId: 'old' }),
    JSON.stringify({ display: 'idle one', timestamp: 300, project: '/p', sessionId: 'idle' }),
    JSON.stringify({ display: 'ailleurs', timestamp: 50, project: '/q', sessionId: 'q1' }),
  ].join('\n'));
  const lives = [
    live({ pid: 10, sessionId: 'idle', cwd: '/p', status: 'idle', updatedAt: 400 }),
    live({ pid: 11, sessionId: 'busy', cwd: '/p', status: 'busy', updatedAt: 350, name: 'repo-1e' }),
  ];
  const groups = buildGroups(lives, history, { recentPerProject: 5, showPast: true });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].project, '/p', 'le projet avec sessions vivantes passe devant');
  assert.equal(groups[0].liveCount, 2);
  assert.equal(groups[0].busyCount, 1);
  assert.deepEqual(groups[0].sessions.map((s) => s.sessionId), ['busy', 'idle', 'old']);
  const old = groups[0].sessions[2];
  assert.equal(old.title, 'premier prompt');
  assert.equal(old.lastPrompt, 'suite');
  assert.equal(old.promptCount, 2);
  assert.equal(groups[0].sessions[0].title, 'repo-1e');
});

test('buildGroups met en tête et compte les sessions qui attendent une validation', () => {
  const lives = [
    live({ pid: 1, sessionId: 'busy', status: 'busy', updatedAt: 300 }),
    live({ pid: 2, sessionId: 'wait', status: 'waiting', updatedAt: 100 }),
    live({ pid: 3, sessionId: 'idle', status: 'idle', updatedAt: 200 }),
  ];
  const [g] = buildGroups(lives, [], { recentPerProject: 5, showPast: true });
  assert.deepEqual(g.sessions.map((s) => s.sessionId), ['wait', 'busy', 'idle']);
  assert.equal(g.waitingCount, 1);
  assert.equal(g.busyCount, 1);
  assert.equal(g.liveCount, 3);
});

test('isInactive masque un projet sans activité récente, jamais un projet vivant ou vide', () => {
  const h = 3_600_000, now = 100 * h;
  const past = (lastActivity: number) => ({ sessionId: 'x', project: '/p', title: '', lastPrompt: '', lastActivity, promptCount: 1, hasRealPrompt: true });
  const group = (lastActivity: number, liveCount = 0) => ({ project: '/p', sessions: [past(lastActivity)], liveCount, busyCount: 0, waitingCount: 0 });
  assert.equal(isInactive(group(now - 47 * h), 48, now), false);
  assert.equal(isInactive(group(now - 49 * h), 48, now), true);
  assert.equal(isInactive(group(now - 49 * h, 1), 48, now), false, 'une session vivante garde le projet visible');
  assert.equal(isInactive(group(now - 49 * h), 0, now), false, '0 : tout afficher');
  assert.equal(isInactive({ project: '/p', sessions: [], liveCount: 0, busyCount: 0, waitingCount: 0 }, 48, now), false, 'dossier de l\'espace de travail sans session');
});

test('buildGroups respecte recentPerProject et showPast', () => {
  const history = parseHistory(
    Array.from({ length: 8 }, (_, i) => JSON.stringify({ display: `p${i}`, timestamp: i, project: '/p', sessionId: `s${i}` })).join('\n'),
  );
  const g = buildGroups([], history, { recentPerProject: 3, showPast: true });
  assert.equal(g[0].sessions.length, 3);
  assert.deepEqual(g[0].sessions.map((s) => s.sessionId), ['s7', 's6', 's5']);
  assert.equal(buildGroups([], history, { recentPerProject: 3, showPast: false }).length, 0);
});

test('truncate et formatRelative', () => {
  assert.equal(truncate('a  b\nc', 10), 'a b c');
  assert.equal(truncate('ma proprio m\'a envoyé ce mail [Pasted text #1 +10 lines], regarde'), 'ma proprio m\'a envoyé ce mail , regarde'.replace(' ,', ','));
  assert.equal(truncate('x'.repeat(100), 10).length, 10);
  assert.equal(formatRelative(1000, 1000 + 30_000), "à l'instant");
  assert.equal(formatRelative(0, 5 * 60_000), 'il y a 5 min');
  assert.equal(formatRelative(0, 3 * 3600_000), 'il y a 3 h');
});

test('buildGroups préfère un vrai prompt à une commande slash comme titre', () => {
  const history = parseHistory([
    JSON.stringify({ display: '/resume', timestamp: 1, project: '/p', sessionId: 'a' }),
    JSON.stringify({ display: 'vrai prompt', timestamp: 2, project: '/p', sessionId: 'a' }),
    JSON.stringify({ display: '/model', timestamp: 1, project: '/p', sessionId: 'b' }),
  ].join('\n'));
  const g = buildGroups([], history, { recentPerProject: 5, showPast: true });
  const byId = Object.fromEntries(g[0].sessions.map((s) => [s.sessionId, s.title]));
  assert.equal(byId.a, 'vrai prompt');
  assert.equal(byId.b, undefined, 'une session passée sans vrai prompt est masquée');
});

test('buildGroups : titre d\'une session vivante = vrai prompt, sinon nom utilisateur, sinon nom généré', () => {
  const history = parseHistory([
    JSON.stringify({ display: 'sujet réel', timestamp: 1, project: '/p', sessionId: 'a' }),
    JSON.stringify({ display: '/resume', timestamp: 1, project: '/p', sessionId: 'b' }),
  ].join('\n'));
  const lives = [
    live({ pid: 1, sessionId: 'a', cwd: '/p', name: 'repo-c6', nameSource: 'derived' }),
    live({ pid: 2, sessionId: 'b', cwd: '/p', name: 'repo-32', nameSource: 'derived' }),
    live({ pid: 3, sessionId: 'c', cwd: '/p', name: 'Mon nom', nameSource: 'user' }),
  ];
  const byId = Object.fromEntries(buildGroups(lives, history, { recentPerProject: 5, showPast: true })[0].sessions.map((s) => [s.sessionId, s.title]));
  assert.equal(byId.a, 'sujet réel');
  assert.equal(byId.b, 'repo-32');
  assert.equal(byId.c, 'Mon nom');
});
