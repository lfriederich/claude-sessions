import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGroups, parseHistory, parsePpid, readLiveSessions, truncate, formatRelative, LiveSession } from './model';

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

test('readLiveSessions filtre les pids morts et les fichiers corrompus', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify(live({ pid: 1, sessionId: 'a', cwd: '/a' })));
  fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify(live({ pid: 2, sessionId: 'b', cwd: '/b' })));
  fs.writeFileSync(path.join(dir, '3.json'), '{broken');
  fs.writeFileSync(path.join(dir, 'x.key'), 'secret');
  const res = readLiveSessions(dir, (pid) => pid === 1);
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
