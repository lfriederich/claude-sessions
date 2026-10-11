// Où trouver de quoi lancer Claude Code quand la commande « claude » n'est pas installée : l'extension
// officielle Claude Code embarque son propre exécutable (resources/native-binary/claude[.exe]).
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Compare deux numéros de version « 2.1.296 » champ par champ. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Exécutable embarqué par la version la plus récente de l'extension Claude Code dans l'un des dossiers
 * d'extensions donnés (~/.vscode/extensions, ~/.vscode-server/extensions…), pour la plateforme voulue.
 */
export function bundledClaude(extensionDirs: string[], windows: boolean): string | undefined {
  let best: { version: string; file: string } | undefined;
  for (const dir of extensionDirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^anthropic\.claude-code-(\d+(?:\.\d+)*)(?:-([a-z0-9]+)-([a-z0-9]+))?$/.exec(name);
      if (!m) continue;
      const platform = m[2];
      if (platform && (platform === 'win32') !== windows) continue;
      const file = path.join(dir, name, 'resources', 'native-binary', windows ? 'claude.exe' : 'claude');
      if (!fs.existsSync(file)) continue;
      if (!best || compareVersions(m[1]!, best.version) > 0) best = { version: m[1]!, file };
    }
  }
  return best?.file;
}

/** La commande est-elle trouvable dans ce PATH ? (côté Linux ; sous Windows on demande à « where »). */
export function onPath(command: string, envPath = process.env.PATH ?? ''): boolean {
  if (command.includes('/')) return fs.existsSync(command);
  return envPath.split(path.delimiter).some((d) => {
    try {
      fs.accessSync(path.join(d, command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Met un chemin entre guillemets s'il contient des espaces (cmd.exe comme bash). */
export const quoted = (p: string): string => (/\s/.test(p) ? `"${p}"` : p);
