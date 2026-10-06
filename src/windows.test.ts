import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LiveSession } from './model';
import { isWindowsPath, parseProcessList, winParents, winSessionAlive, winToWsl, wslToWin } from './windows';

const live = (o: Partial<LiveSession>): LiveSession => ({ pid: 1, sessionId: 's', cwd: 'C:\\p', ...o });

test('winToWsl / wslToWin : lecteur, racine, aller-retour, chemins hors lecteur', () => {
  assert.equal(winToWsl('C:\\Users\\x\\mon projet'), '/mnt/c/Users/x/mon projet');
  assert.equal(winToWsl('D:/data/'), '/mnt/d/data');
  assert.equal(winToWsl('C:\\'), '/mnt/c');
  assert.equal(winToWsl('\\\\serveur\\partage'), undefined, 'UNC : pas de montage WSL');
  assert.equal(wslToWin('/mnt/c/Users/x/mon projet'), 'C:\\Users\\x\\mon projet');
  assert.equal(wslToWin('/mnt/c'), 'C:\\');
  assert.equal(wslToWin('/home/x'), undefined);
  assert.equal(wslToWin('/mnt/wsl/x'), undefined, 'pas un lecteur');
  assert.equal(wslToWin(winToWsl('E:\\a\\b')!), 'E:\\a\\b');
  assert.ok(isWindowsPath('C:\\x') && isWindowsPath('c:/x') && !isWindowsPath('/mnt/c') && !isWindowsPath('C:'));
});

test('parseProcessList : lignes valides seulement, nom pouvant contenir le séparateur', () => {
  const procs = parseProcessList('4|0|1700000000000|System\r\n\r\nPS > bruit\n1234|4|1700000001000|a|b.exe\n0|0|0|Idle\n99|1||sans date\n');
  assert.deepEqual([...procs.keys()], [4, 1234]);
  assert.equal(procs.get(1234)!.name, 'a|b.exe');
});

test('winSessionAlive : pid présent et créé au plus tard peu après le démarrage de la session', () => {
  const procs = parseProcessList('10|1|1000000|node.exe\n20|1|9000000|ping.exe');
  assert.equal(winSessionAlive(live({ pid: 10, startedAt: 1000500 }), procs), true);
  assert.equal(winSessionAlive(live({ pid: 20, startedAt: 1000500 }), procs), false, 'pid réattribué : processus créé bien après la session');
  assert.equal(winSessionAlive(live({ pid: 30, startedAt: 1000500 }), procs), false, 'processus disparu');
  assert.equal(winSessionAlive(live({ pid: 20 }), procs), true, 'sans startedAt, le pid fait foi');
});

test('winParents : remonte la chaîne, s\'arrête sur un parent créé après son enfant', () => {
  const procs = parseProcessList([
    '100|50|5000|node.exe', '50|40|4000|cmd.exe', '40|30|3000|powershell.exe', '30|20|9999|réattribué.exe', '20|1|1|explorer.exe',
  ].join('\n'));
  assert.deepEqual(winParents(100, procs), [50, 40], '30 a été créé après 40 : ce n\'est pas son vrai parent');
  assert.deepEqual(winParents(100, procs, 1), [50]);
  assert.deepEqual(winParents(999, procs), []);
});
