import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bundledClaude, compareVersions, onPath, quoted } from './claudeBinary';

function fakeExt(root: string, name: string, exe: string) {
  const d = path.join(root, name, 'resources', 'native-binary');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, exe), '');
}

test('compareVersions compare numériquement', () => {
  assert.ok(compareVersions('2.1.296', '2.1.289') > 0);
  assert.ok(compareVersions('2.10.0', '2.9.9') > 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
});

test("bundledClaude prend la version la plus récente de la bonne plateforme", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ext-'));
  fakeExt(root, 'anthropic.claude-code-2.1.289-linux-x64', 'claude');
  fakeExt(root, 'anthropic.claude-code-2.1.296-linux-x64', 'claude');
  fakeExt(root, 'anthropic.claude-code-2.1.300-win32-x64', 'claude.exe');
  fakeExt(root, 'autre.extension-1.0.0', 'claude');
  assert.equal(bundledClaude([root], false), path.join(root, 'anthropic.claude-code-2.1.296-linux-x64', 'resources', 'native-binary', 'claude'));
  assert.equal(bundledClaude([root, '/nexiste/pas'], true), path.join(root, 'anthropic.claude-code-2.1.300-win32-x64', 'resources', 'native-binary', 'claude.exe'));
  assert.equal(bundledClaude(['/nexiste/pas'], false), undefined);
});

test('onPath et quoted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bin-'));
  fs.writeFileSync(path.join(dir, 'outil'), '', { mode: 0o755 });
  assert.equal(onPath('outil', dir), true);
  assert.equal(onPath('absent', dir), false);
  assert.equal(quoted('C:\\Users\\A B\\claude.exe'), '"C:\\Users\\A B\\claude.exe"');
  assert.equal(quoted('/usr/bin/claude'), '/usr/bin/claude');
});
