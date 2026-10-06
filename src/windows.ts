// Sessions Claude Code côté Windows : vues depuis une fenêtre WSL (fichiers par /mnt/<lecteur>, programmes
// Windows par l'interop) ou depuis un VS Code lancé directement sous Windows. Dans les deux cas, ni /proc ni
// process.kill(pid, 0) ne renseignent sur un pid Windows vu de WSL : un PowerShell resté ouvert liste les
// processus Windows. Mesuré : 0,15 à 0,2 s par requête une fois démarré, 4 à 10 s par démarrage à froid.
import { ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import type { LiveSession } from './model';

const ON_WINDOWS = process.platform === 'win32';
const SYSTEM32 = '/mnt/c/Windows/System32/';
export const CMD = ON_WINDOWS ? 'cmd.exe' : `${SYSTEM32}cmd.exe`;
const POWERSHELL = ON_WINDOWS ? 'powershell.exe' : `${SYSTEM32}WindowsPowerShell/v1.0/powershell.exe`;
const TASKKILL = ON_WINDOWS ? 'taskkill.exe' : `${SYSTEM32}taskkill.exe`;
/** Depuis WSL, un programme Windows lancé hors de /mnt/<lecteur> se plaint d'un chemin UNC. */
const WIN_CWD = ON_WINDOWS ? undefined : '/mnt/c';

export interface WinProcess { pid: number; ppid: number; created: number; name: string }

export const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p);

export function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** C:\Users\x → /mnt/c/Users/x (montage automatique par défaut de WSL). Chemin UNC ou réseau : undefined. */
export function winToWsl(p: string, mount = '/mnt/'): string | undefined {
  const m = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(p);
  return m ? `${mount}${m[1].toLowerCase()}/${(m[2] ?? '').replace(/\\/g, '/')}`.replace(/\/+$/, '') : undefined;
}

/** /mnt/c/Users/x → C:\Users\x. Hors du montage d'un lecteur : undefined. */
export function wslToWin(p: string, mount = '/mnt/'): string | undefined {
  if (!p.startsWith(mount)) return undefined;
  const m = /^([a-z])(?:\/(.*))?$/i.exec(p.slice(mount.length));
  return m ? `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\/+$/, '').replace(/\//g, '\\')}` : undefined;
}

/** Lignes « pid|ppid|création en ms|nom » produites par PROCESS_QUERY. */
export function parseProcessList(text: string): Map<number, WinProcess> {
  const out = new Map<number, WinProcess>();
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, created, ...name] = line.trim().split('|');
    const p = { pid: Number(pid), ppid: Number(ppid), created: Number(created), name: name.join('|') };
    if (Number.isInteger(p.pid) && p.pid > 0 && Number.isInteger(p.ppid) && Number.isFinite(p.created) && created !== '') out.set(p.pid, p);
  }
  return out;
}

/**
 * Session Windows encore vivante : son pid existe, et le processus qui le porte n'a pas été créé après le
 * démarrage de la session (sinon c'est un pid réattribué à un autre programme depuis).
 */
export function winSessionAlive(s: LiveSession, procs: Map<number, WinProcess>): boolean {
  const p = procs.get(s.pid);
  return !!p && (s.startedAt === undefined || p.created <= s.startedAt + 120_000);
}

/** Chaîne des parents d'un processus Windows, d'après un relevé. */
export function winParents(pid: number, procs: Map<number, WinProcess>, depth = 8): number[] {
  const out: number[] = [];
  let cur = procs.get(pid);
  for (let i = 0; i < depth && cur; i++) {
    const parent = procs.get(cur.ppid);
    // Windows réattribue les pids : un « parent » créé après son enfant n'est pas le vrai parent, qui est mort.
    if (!parent || parent.created > cur.created) break;
    out.push(parent.pid);
    cur = parent;
  }
  return out;
}

/** %USERPROFILE%\.claude vu depuis WSL (/mnt/c/Users/<nom>/.claude), s'il existe. */
export function windowsClaudeDirFromWsl(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(CMD, ['/c', 'echo %USERPROFILE%'], { cwd: WIN_CWD, timeout: 15_000, windowsHide: true }, (err, stdout) => {
      const home = err ? undefined : winToWsl(stdout.trim());
      const dir = home && `${home}/.claude`;
      resolve(dir && fs.existsSync(dir) ? dir : undefined);
    });
  });
}

/** Arrêt immédiat d'un processus Windows et de ses enfants (pas d'équivalent à SIGTERM pour une console). */
export function killWindowsProcess(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(TASKKILL, ['/PID', String(pid), '/T', '/F'], { cwd: WIN_CWD, timeout: 15_000, windowsHide: true },
      (err, _out, stderr) => (err ? reject(new Error(String(stderr).trim() || err.message)) : resolve()));
  });
}

const PROCESS_QUERY = "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId,$_.ParentProcessId,([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(),$_.Name }";

/** Liste des processus Windows, par un PowerShell gardé ouvert entre deux relevés. */
export class WindowsProcesses {
  private ps?: ChildProcessWithoutNullStreams;
  private buf = '';
  private last?: { at: number; procs: Map<number, WinProcess> };
  private pending?: Promise<Map<number, WinProcess> | undefined>;

  constructor(private readonly log: (message: string) => void) {}

  /**
   * Relevé de moins de maxAgeMs. Sinon en lance un et l'attend au plus waitMs : au-delà (PowerShell qui
   * démarre à froid), renvoie le relevé précédent, ou rien, et appelle onLate quand le nouveau arrive.
   */
  async snapshot(opts: { maxAgeMs: number; waitMs: number; onLate?: () => void }): Promise<Map<number, WinProcess> | undefined> {
    if (this.last && Date.now() - this.last.at < opts.maxAgeMs) return this.last.procs;
    const pending = (this.pending ??= this.query().finally(() => { this.pending = undefined; }));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), opts.waitMs); });
    const res = await Promise.race([pending, timeout]);
    clearTimeout(timer);
    if (res !== 'timeout') return res;
    void pending.then((procs) => { if (procs) opts.onLate?.(); });
    return this.last?.procs;
  }

  dispose(): void {
    this.ps?.kill();
    this.ps = undefined;
  }

  private async query(): Promise<Map<number, WinProcess> | undefined> {
    try {
      const procs = parseProcessList(await this.run(PROCESS_QUERY, 30_000));
      if (!procs.size) throw new Error('liste vide');
      this.last = { at: Date.now(), procs };
      return procs;
    } catch (e) {
      this.log(`processus Windows illisibles : ${e instanceof Error ? e.message : e}`);
      this.dispose(); // un PowerShell bloqué ou mort est relancé au relevé suivant
      return undefined;
    }
  }

  /** Une commande dans le PowerShell persistant ; la sortie est lue jusqu'à un marqueur de fin. */
  private run(command: string, timeoutMs: number): Promise<string> {
    if (!this.ps || this.ps.exitCode !== null) {
      this.ps = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', '-'], { cwd: WIN_CWD, windowsHide: true });
      this.ps.stdout.setEncoding('utf8');
      this.ps.stderr.resume();
      this.ps.stdin.on('error', () => { /* PowerShell mort : signalé par 'exit' */ });
      this.buf = '';
    }
    const ps = this.ps;
    return new Promise((resolve, reject) => {
      const mark = `__claude_sessions_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
      const done = (err?: Error, out?: string) => {
        clearTimeout(timer);
        ps.stdout.off('data', onData);
        ps.off('exit', onExit);
        ps.off('error', onExit);
        if (err) reject(err); else resolve(out ?? '');
      };
      const onData = (d: string) => {
        this.buf += d;
        const i = this.buf.indexOf(mark);
        if (i < 0) return;
        const out = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + mark.length).replace(/^\r?\n/, '');
        done(undefined, out);
      };
      const onExit = (e?: unknown) => done(new Error(e instanceof Error ? e.message : 'PowerShell s\'est arrêté'));
      const timer = setTimeout(() => done(new Error(`pas de réponse en ${timeoutMs} ms`)), timeoutMs);
      ps.stdout.on('data', onData);
      ps.once('exit', onExit);
      ps.once('error', onExit);
      ps.stdin.write(`${command}\nWrite-Output '${mark}'\n`);
    });
  }
}
