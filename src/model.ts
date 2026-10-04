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

export function readLiveSessions(
  dir: string = path.join(claudeDir(), 'sessions'),
  alive: (pid: number) => boolean = isPidAlive,
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
      if (!alive(raw.pid)) continue;
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

export function readHistory(file: string = path.join(claudeDir(), 'history.jsonl')): HistoryEntry[] {
  try {
    return parseHistory(fs.readFileSync(file, 'utf8'));
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
      g = { project: s.project, sessions: [], liveCount: 0, busyCount: 0 };
      groups.set(s.project, g);
    }
    g.sessions.push(s);
    if (s.live) {
      g.liveCount++;
      if (isBusy(s.live)) g.busyCount++;
    }
  }

  const rank = (s: SessionInfo) => (s.live ? (isBusy(s.live) ? 0 : 1) : 2);
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

export function parsePpid(stat: string): number | undefined {
  // Format : "pid (comm) state ppid ..." ; comm peut contenir des espaces et des parenthèses.
  const close = stat.lastIndexOf(')');
  if (close < 0) return undefined;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  return Number.isFinite(ppid) ? ppid : undefined;
}

export function formatRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `il y a ${d} j`;
  return new Date(ts).toLocaleDateString('fr-FR');
}

export function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')}`;
}
