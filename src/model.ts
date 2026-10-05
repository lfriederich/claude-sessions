// Logique pure, sans dépendance à l'API vscode : lecture du registre de sessions
// Claude Code (~/.claude/sessions/*.json), de l'historique (~/.claude/history.jsonl)
// et construction de l'arbre projets → sessions.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  /** Heure de démarrage du processus, telle que dans /proc/<pid>/stat (Linux). */
  procStart?: string;
  name?: string;
  nameSource?: string;
  status?: string;
  kind?: string;
  version?: string;
  startedAt?: number;
  updatedAt?: number;
  statusUpdatedAt?: number;
}

export interface HistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId: string;
}

export interface SessionInfo {
  sessionId: string;
  project: string;
  /** Premier prompt de la session, tronqué : sert de titre. */
  title: string;
  lastPrompt: string;
  lastActivity: number;
  promptCount: number;
  /** Au moins un prompt qui n'est pas une commande slash. */
  hasRealPrompt: boolean;
  live?: LiveSession;
}

export interface ProjectGroup {
  project: string;
  sessions: SessionInfo[];
  liveCount: number;
  busyCount: number;
  waitingCount: number;
}

export interface BuildOptions {
  recentPerProject: number;
  showPast: boolean;
}

export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Le registre garde les fichiers des sessions tuées, et après un redémarrage de WSL les pids sont
 * réattribués : un pid vivant ne suffit pas, il faut que le processus soit celui qui a écrit le fichier.
 */
export function isSessionAlive(s: LiveSession, procRoot = '/proc'): boolean {
  if (!isPidAlive(s.pid)) return false;
  if (s.procStart === undefined) return true;
  const start = procStartTime(s.pid, procRoot);
  return start === undefined || start === String(s.procStart); // pas de /proc (macOS, Windows) : le pid fait foi
}

export function readLiveSessions(
  dir: string = path.join(claudeDir(), 'sessions'),
  alive: (s: LiveSession) => boolean = (s) => isSessionAlive(s),
): LiveSession[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: LiveSession[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Partial<LiveSession>;
      if (typeof raw.pid !== 'number' || typeof raw.sessionId !== 'string' || typeof raw.cwd !== 'string') continue;
      if (!alive(raw as LiveSession)) continue;
      out.push(raw as LiveSession);
    } catch {
      // fichier en cours d'écriture ou corrompu : ignoré
    }
  }
  return out;
}

export function parseHistory(text: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<HistoryEntry>;
      if (typeof e.sessionId === 'string' && typeof e.project === 'string' && typeof e.timestamp === 'number') {
        out.push({ display: typeof e.display === 'string' ? e.display : '', timestamp: e.timestamp, project: e.project, sessionId: e.sessionId });
      }
    } catch {
      // ligne tronquée : ignorée
    }
  }
  return out;
}

// L'historique pèse plusieurs Mo et ne change qu'à chaque prompt : on ne le relit que s'il a bougé.
let historyCache: { file: string; mtimeMs: number; size: number; entries: HistoryEntry[] } | undefined;

export function readHistory(file: string = path.join(claudeDir(), 'history.jsonl')): HistoryEntry[] {
  try {
    const { mtimeMs, size } = fs.statSync(file);
    if (historyCache && historyCache.file === file && historyCache.mtimeMs === mtimeMs && historyCache.size === size) return historyCache.entries;
    const entries = parseHistory(fs.readFileSync(file, 'utf8'));
    historyCache = { file, mtimeMs, size, entries };
    return entries;
  } catch {
    return [];
  }
}

export function truncate(s: string, max = 60): string {
  // Les marqueurs de collage de Claude Code (« [Pasted text #1 +10 lines] ») n'apportent rien dans un titre.
  const one = s.replace(/\[Pasted text[^\]]*\]/gi, '').replace(/\s+([,.;:!?])/g, '$1').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

export function isBusy(s: LiveSession): boolean {
  return (s.status ?? '').toLowerCase() === 'busy';
}

/** Bloquée sur une demande de permission ou une question (« waitingFor: dialog open »). */
export function isWaiting(s: LiveSession): boolean {
  return (s.status ?? '').toLowerCase() === 'waiting';
}

export type LiveStatus = 'busy' | 'waiting' | 'idle';

export function liveStatus(s: LiveSession): LiveStatus {
  return isWaiting(s) ? 'waiting' : isBusy(s) ? 'busy' : 'idle';
}

/** Ce qui mérite d'être signalé entre deux relevés : une fin de travail, ou une demande de validation. */
export function notableTransition(before: LiveStatus | undefined, now: LiveStatus): 'done' | 'waiting' | undefined {
  if (!before || before === now) return undefined; // premier relevé : on ne connaît pas l'état précédent
  if (now === 'waiting') return 'waiting';
  if (before === 'busy' && now === 'idle') return 'done';
  return undefined;
}

export function buildGroups(live: LiveSession[], history: HistoryEntry[], opts: BuildOptions): ProjectGroup[] {
  const byId = new Map<string, SessionInfo>();

  for (const h of history) {
    let s = byId.get(h.sessionId);
    if (!s) {
      s = { sessionId: h.sessionId, project: h.project, title: truncate(h.display), lastPrompt: h.display, lastActivity: h.timestamp, promptCount: 0, hasRealPrompt: false };
      byId.set(h.sessionId, s);
    }
    s.promptCount++;
    const real = h.display.trim() !== '' && !h.display.trim().startsWith('/');
    // Une commande slash (« /resume », « /model ») fait un mauvais titre : on préfère le premier vrai prompt.
    if (real && !s.hasRealPrompt) s.title = truncate(h.display);
    s.hasRealPrompt ||= real;
    if (h.timestamp >= s.lastActivity) {
      s.lastActivity = h.timestamp;
      s.lastPrompt = h.display;
      s.project = h.project;
    }
  }

  for (const l of live) {
    const existing = byId.get(l.sessionId);
    const activity = Math.max(l.updatedAt ?? 0, l.statusUpdatedAt ?? 0, l.startedAt ?? 0);
    // Un nom choisi par l'utilisateur (/rename) prime ; le nom généré (« repo-c6 ») ne sert qu'à défaut de vrai prompt.
    const userName = l.name && l.nameSource && l.nameSource !== 'derived' ? l.name : undefined;
    if (existing) {
      existing.live = l;
      existing.project = l.cwd;
      existing.lastActivity = Math.max(existing.lastActivity, activity);
      if (userName) existing.title = userName;
      else if (!existing.hasRealPrompt) existing.title = l.name ?? existing.title;
    } else {
      byId.set(l.sessionId, {
        sessionId: l.sessionId, project: l.cwd, title: userName ?? l.name ?? 'Nouvelle session', lastPrompt: '',
        lastActivity: activity, promptCount: 0, hasRealPrompt: false, live: l,
      });
    }
  }

  const groups = new Map<string, ProjectGroup>();
  for (const s of byId.values()) {
    if (!s.live && !opts.showPast) continue;
    // Une session passée sans aucun vrai prompt (juste « /resume ») n'apporte rien.
    if (!s.live && !s.hasRealPrompt) continue;
    let g = groups.get(s.project);
    if (!g) {
      g = { project: s.project, sessions: [], liveCount: 0, busyCount: 0, waitingCount: 0 };
      groups.set(s.project, g);
    }
    g.sessions.push(s);
    if (s.live) {
      g.liveCount++;
      if (isBusy(s.live)) g.busyCount++;
      if (isWaiting(s.live)) g.waitingCount++;
    }
  }

  // Celles qui attendent une validation d'abord : ce sont les seules qui ont besoin de l'utilisateur.
  const rank = (s: SessionInfo) => (s.live ? (isWaiting(s.live) ? 0 : isBusy(s.live) ? 1 : 2) : 3);
  const result: ProjectGroup[] = [];
  for (const g of groups.values()) {
    g.sessions.sort((a, b) => rank(a) - rank(b) || b.lastActivity - a.lastActivity);
    const liveOnes = g.sessions.filter((s) => s.live);
    const past = g.sessions.filter((s) => !s.live).slice(0, Math.max(0, opts.recentPerProject));
    g.sessions = [...liveOnes, ...past];
    if (g.sessions.length) result.push(g);
  }
  const lastOf = (g: ProjectGroup) => Math.max(...g.sessions.map((s) => s.lastActivity));
  result.sort((a, b) => b.liveCount - a.liveCount || lastOf(b) - lastOf(a));
  return result;
}

/** Session terminée dont la dernière activité est plus ancienne que le seuil (0 : jamais). Une session vivante ne l'est jamais. */
export function isInactiveSession(s: SessionInfo, hours: number, now = Date.now()): boolean {
  return hours > 0 && !s.live && now - s.lastActivity > hours * 3_600_000;
}

/** Projet à masquer : toutes ses sessions sont inactives (donc aucune vivante). Un projet sans session ne l'est pas. */
export function isInactive(g: ProjectGroup, hours: number, now = Date.now()): boolean {
  return g.sessions.length > 0 && g.sessions.every((s) => isInactiveSession(s, hours, now));
}

/** Racine du dépôt git qui contient ce dossier (présence d'un .git, fichier ou dossier), sans lancer git. */
export function gitRoot(dir: string): string | undefined {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return undefined;
  }
}

/**
 * Dépôts git où travaillent plusieurs sessions vivantes à la fois (racine -> sessions) : elles risquent
 * d'écraser le travail non commité l'une de l'autre. Deux worktrees distincts ont des racines distinctes.
 */
export function sharedRepositories(groups: ProjectGroup[], rootOf: (dir: string) => string | undefined = gitRoot): Map<string, SessionInfo[]> {
  const byRoot = new Map<string, SessionInfo[]>();
  for (const g of groups) for (const s of g.sessions) {
    const root = s.live ? rootOf(s.project) : undefined;
    if (root) byRoot.set(root, [...(byRoot.get(root) ?? []), s]);
  }
  for (const [root, sessions] of byRoot) if (sessions.length < 2) byRoot.delete(root);
  return byRoot;
}

export interface ChangedFile { path: string; letter: string }

/** Lettre d'un statut de l'API Git (enum Status de git.d.ts), comme dans la vue Contrôle de code source. */
export function changeLetter(status: number): string {
  if (status >= 12) return '!'; // ADDED_BY_US … BOTH_MODIFIED : conflit
  return ['M', 'A', 'D', 'R', 'C', 'M', 'D', 'U', 'I', 'A', 'R', 'T'][status] ?? '?';
}

/**
 * Une entrée par fichier à partir des groupes de l'API Git, passés par ordre de priorité (conflits,
 * copie de travail, non suivis, index) : un fichier modifié à la fois dans l'index et la copie de
 * travail n'apparaît qu'une fois, avec le statut le plus parlant.
 */
export function mergeChanges(groups: { path: string; status: number }[][]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const group of groups) for (const c of group) if (!byPath.has(c.path)) byPath.set(c.path, { path: c.path, letter: changeLetter(c.status) });
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Remonte la chaîne des processus parents (Linux, via /proc). */
export function parentPids(pid: number, depth = 6, procRoot = '/proc'): number[] {
  const out: number[] = [];
  let cur = pid;
  for (let i = 0; i < depth; i++) {
    let stat: string;
    try {
      stat = fs.readFileSync(path.join(procRoot, String(cur), 'stat'), 'utf8');
    } catch {
      break;
    }
    const ppid = parsePpid(stat);
    if (ppid === undefined || ppid <= 1) break;
    out.push(ppid);
    cur = ppid;
  }
  return out;
}

/** Champ n (numérotation de proc(5), à partir de 1) de /proc/<pid>/stat. */
function statField(stat: string, n: number): string | undefined {
  // Format : "pid (comm) state ppid ..." ; comm peut contenir des espaces et des parenthèses.
  const close = stat.lastIndexOf(')');
  if (close < 0) return undefined;
  return stat.slice(close + 1).trim().split(/\s+/)[n - 3];
}

export function parsePpid(stat: string): number | undefined {
  const ppid = Number(statField(stat, 4));
  return Number.isFinite(ppid) ? ppid : undefined;
}

export function parseStartTime(stat: string): string | undefined {
  return statField(stat, 22);
}

export function procStartTime(pid: number, procRoot = '/proc'): string | undefined {
  try {
    return parseStartTime(fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8'));
  } catch {
    return undefined;
  }
}
