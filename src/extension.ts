import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CMD, WinProcess, WindowsProcesses, isWindowsPath, isWsl, killWindowsProcess, winParents, winSessionAlive, winToWsl, windowsClaudeDirFromWsl, wslToWin } from './windows';
import { LiveSession, LiveStatus, ProjectGroup, SessionInfo, baseName, buildGroups, claudeDir, gitRoot, isBusy, isInactive, isInactiveSession, isSessionAlive, isWaiting, liveStatus, mergeChanges, notableTransition, parentPids, sharedRepositories, readHistory, readLiveSessions, truncate } from './model';

const VIEW_ID = 'claudeSessions.view';

/** Journal « Claude Sessions » (panneau Sortie) : VS Code l'écrit aussi dans un fichier de ses logs. */
let log: vscode.LogOutputChannel;

function cfg<T>(key: string, def: T): T {
  return vscode.workspace.getConfiguration('claudeSessions').get<T>(key, def);
}

const ON_WINDOWS = process.platform === 'win32';
/** Session Windows vue depuis WSL : ses chemins et ses pids ne sont pas ceux de la machine de l'extension. */
const isForeign = (p: string): boolean => !ON_WINDOWS && isWindowsPath(p);
/** Chemins Windows comparés sans tenir compte de la casse ni du séparateur. */
const samePath = (a: string, b: string): boolean => {
  const n = (p: string) => (isWindowsPath(p) ? p.replace(/\//g, '\\').toLowerCase() : p).replace(/[\\/]+$/, '');
  return n(a) === n(b);
};

function hasRegistry(dir: string): boolean {
  try {
    return fs.readdirSync(path.join(dir, 'sessions')).some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}

// ---------- Terminaux ----------

/** Terminaux ouverts par l'extension (reprise ou nouvelle session), indexés par session ou par projet. */
const ownTerminals = new Map<string, vscode.Terminal>();
/**
 * Nouvelles sessions lancées par l'extension, pas encore rattachées à leur entrée du registre. Une session
 * Windows lancée depuis WSL ne se retrouve pas par les pids : on la reconnaît à son dossier et à son heure.
 */
const pendingNew: { project: string; term: vscode.Terminal; at: number }[] = [];

async function terminalPids(): Promise<Map<number, vscode.Terminal>> {
  const map = new Map<number, vscode.Terminal>();
  await Promise.all(vscode.window.terminals.map(async (t) => {
    const pid = await t.processId;
    if (pid !== undefined) map.set(pid, t);
  }));
  return map;
}

function terminalFor(live: LiveSession, pids: Map<number, vscode.Terminal>, procs?: Map<number, WinProcess>): vscode.Terminal | undefined {
  if (isForeign(live.cwd)) return undefined; // pids Windows, sans rapport avec ceux des terminaux WSL
  // Sous Windows, pas de /proc : la parenté vient du relevé PowerShell.
  const parents = ON_WINDOWS ? (procs ? winParents(live.pid, procs) : []) : parentPids(live.pid);
  for (const p of parents) {
    const t = pids.get(p);
    if (t) return t;
  }
  return undefined;
}

function createClaudeTerminal(key: string, name: string, project: string, command: string): vscode.Terminal | undefined {
  const existing = ownTerminals.get(key);
  if (existing && existing.exitStatus === undefined) return existing;
  let options: vscode.TerminalOptions = { name: truncate(name, 32), cwd: project, iconPath: new vscode.ThemeIcon('hubot') };
  if (isForeign(project)) {
    // Session Windows lancée depuis WSL : cmd.exe par l'interop, dans le dossier traduit en /mnt/<lecteur>,
    // que l'interop retraduit en C:\…. cmd plutôt que PowerShell : il trouve claude.exe comme le claude.cmd de
    // npm, sans buter sur la politique d'exécution qui bloque claude.ps1.
    const cwd = winToWsl(project);
    if (!cwd) {
      void vscode.window.showErrorMessage(`Dossier Windows inaccessible depuis WSL : ${project}`);
      return undefined;
    }
    options = { ...options, name: truncate(`${name} · Windows`, 32), cwd, shellPath: CMD, shellArgs: ['/k', command] };
  }
  const term = vscode.window.createTerminal(options);
  if (!options.shellArgs) term.sendText(command);
  ownTerminals.set(key, term);
  return term;
}

/** Commande Claude de la machine où tournera la session. */
const claudeCommand = (project: string): string => (isForeign(project) ? cfg('windowsClaudeCommand', 'claude') : cfg('claudeCommand', 'claude'));

function resumeInTerminal(s: SessionInfo): vscode.Terminal | undefined {
  return createClaudeTerminal(s.sessionId, s.title || baseName(s.project), s.project, `${claudeCommand(s.project)} --resume ${s.sessionId}`);
}

function newSessionInTerminal(project: string): vscode.Terminal | undefined {
  const term = createClaudeTerminal(`new:${project}:${Date.now()}`, `claude · ${baseName(project)}`, project, claudeCommand(project));
  if (term) pendingNew.push({ project, term, at: Date.now() });
  return term;
}

// ---------- Projet ----------

function isInsideWorkspace(p: string): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some((f) => {
    const root = f.uri.fsPath;
    return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

async function revealProject(projectPath: string, behaviorOverride?: string): Promise<void> {
  const uri = vscode.Uri.file(projectPath);
  if (!fs.existsSync(projectPath)) {
    void vscode.window.showWarningMessage(`Dossier introuvable : ${projectPath}`);
    return;
  }
  const behavior = behaviorOverride ?? cfg<string>('openBehavior', 'addToWorkspace');
  if (!isInsideWorkspace(projectPath)) {
    if (behavior === 'newWindow' || behavior === 'sameWindow') {
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: behavior === 'newWindow' });
      return;
    }
    const idx = vscode.workspace.workspaceFolders?.length ?? 0;
    if (!vscode.workspace.updateWorkspaceFolders(idx, 0, { uri, name: path.basename(projectPath) })) {
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
      return;
    }
  }
  await expandInExplorer(projectPath);
}

/** Première entrée visible d'un dossier, de préférence un fichier parlant (README, package.json…). */
function firstEntry(dir: string): string | undefined {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    if (!entries.length) return undefined;
    const preferred = ['README.md', 'readme.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'].find((n) => entries.includes(n));
    return path.join(dir, preferred ?? entries[0]);
  } catch {
    return undefined;
  }
}

/**
 * Montre l'arborescence du projet dans l'explorateur : replie les autres dossiers, puis révèle une
 * entrée du projet (ce qui déplie le dossier parent) et resélectionne le dossier lui-même.
 */
async function expandInExplorer(projectPath: string): Promise<void> {
  const uri = vscode.Uri.file(projectPath);
  if (cfg('collapseOthersInExplorer', true)) {
    await vscode.commands.executeCommand('workbench.files.action.collapseExplorerFolders');
  }
  const child = firstEntry(projectPath);
  if (child) await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(child));
  await vscode.commands.executeCommand('revealInExplorer', uri);
}

// ---------- Git ----------

/** Sous-ensemble de l'API v1 de l'extension Git intégrée (extensions/git/src/api/git.d.ts). */
interface GitChange { readonly uri: vscode.Uri; readonly status: number }
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly workingTreeChanges: GitChange[]; readonly indexChanges: GitChange[]; readonly mergeChanges: GitChange[];
    readonly untrackedChanges?: GitChange[]; readonly onDidChange: vscode.Event<void>;
  };
}
interface GitAPI {
  readonly repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
}

async function gitApi(): Promise<GitAPI | undefined> {
  try {
    const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitAPI }>('vscode.git');
    return ext ? (await ext.activate()).getAPI(1) : undefined;
  } catch (e) {
    log.warn(`API de l'extension Git indisponible : ${e}`);
    return undefined;
  }
}

/** Nombre de fichiers envoyés au webview : au-delà, un lien vers la vue Contrôle de code source. */
const MAX_CHANGED_FILES = 15;

/** Dépôts déjà confiés à l'extension Git : une fois par démarrage, pour ne pas rouvrir un dépôt fermé à la main. */
const openedRepos = new Set<string>();

/**
 * Fait détecter par l'extension Git de VS Code le dépôt d'un projet. Elle ne cherche les dépôts qu'à
 * git.repositoryScanMaxDepth (1 par défaut) sous le dossier ouvert : plus bas, ses fichiers modifiés
 * n'apparaissent pas dans l'explorateur. Hors de l'espace de travail, l'explorateur ne montre rien : on s'abstient.
 */
async function openGitRepository(project: string): Promise<void> {
  if (!cfg('openGitRepositories', true) || !isInsideWorkspace(project)) return;
  const root = gitRoot(project);
  if (!root || openedRepos.has(root)) return;
  openedRepos.add(root);
  try {
    await vscode.commands.executeCommand('git.openRepository', root);
  } catch (e) {
    console.warn('[claude-sessions] git.openRepository a échoué :', e);
  }
}

/**
 * Déplace la vue dans le conteneur du panneau Terminal, pour qu'elle s'affiche en permanence
 * à côté des terminaux. Le manifeste ne permet pas de cibler ce conteneur, mais la commande
 * interne « vscode.moveViews » le fait ; VS Code mémorise ensuite l'emplacement.
 */
async function dockToTerminal(): Promise<boolean> {
  try {
    await vscode.commands.executeCommand('vscode.moveViews', { viewIds: [VIEW_ID], destinationId: 'terminal' });
    return true;
  } catch (e) {
    console.warn('[claude-sessions] vscode.moveViews a échoué :', e);
    return false;
  }
}

// ---------- Vue ----------

interface WireSession {
  sessionId: string; title: string; lastPrompt: string; lastActivity: number; promptCount: number;
  live?: { pid: number; busy: boolean; waiting: boolean };
  inThisWindow: boolean;
  inactive: boolean;
  /** Titres des autres sessions vivantes du même dépôt git. */
  sharedWith?: string[];
}
interface WireChanges { sessionId: string; repo: string; total: number; files: { abs: string; rel: string; letter: string }[] }
interface WireGroup { project: string; liveCount: number; busyCount: number; waitingCount: number; inactive: boolean; windows: boolean; sessions: WireSession[] }

class SessionsView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  groups: ProjectGroup[] = [];
  private selectedId: string | null = null;
  private terminals = new Map<string, vscode.Terminal>(); // sessionId -> terminal hébergeant la session (cette fenêtre)
  private lastStatus = new Map<string, LiveStatus>(); // statut au relevé précédent, pour détecter les transitions
  private shared = new Map<string, SessionInfo[]>(); // racine git -> sessions vivantes qui la partagent
  private warnedShared = new Set<string>(); // groupes déjà signalés : une notification par groupe et par démarrage
  git?: GitAPI;
  /** %USERPROFILE%\.claude vu depuis WSL, quand les sessions Windows sont affichées. */
  windowsDir?: string;
  readonly winProcs = new WindowsProcesses((m) => log.warn(m));

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly onChanged: () => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    view.onDidChangeVisibility(() => { if (view.visible) void this.refresh(); });
  }

  async refresh(): Promise<void> {
    const pids = await terminalPids();
    const winDir = this.windowsDir;
    // Pids Windows : relevé PowerShell, seulement s'il y a des sessions Windows à vérifier.
    const needProcs = ON_WINDOWS ? hasRegistry(claudeDir()) : !!winDir && hasRegistry(winDir);
    const procs = needProcs ? await this.winProcs.snapshot({ maxAgeMs: 4000, waitMs: 1500, onLate: () => void this.refresh() }) : undefined;
    const live = ON_WINDOWS
      // Sans relevé (PowerShell qui démarre), process.kill(pid, 0) fonctionne sous Windows, sans détecter les pids réattribués.
      ? readLiveSessions(undefined, procs ? (s) => winSessionAlive(s, procs) : (s) => isSessionAlive(s))
      // Depuis WSL, une session Windows ne peut être dite vivante que d'après un relevé.
      : [...readLiveSessions(), ...(winDir && procs ? readLiveSessions(path.join(winDir, 'sessions'), (s) => winSessionAlive(s, procs)) : [])];
    const history = [...readHistory(), ...(winDir ? readHistory(path.join(winDir, 'history.jsonl')) : [])];
    this.groups = buildGroups(live, history, {
      recentPerProject: cfg('recentPerProject', 5),
      showPast: cfg('showPastSessions', true),
    });
    // Les dossiers de l'espace de travail sans session apparaissent aussi, pour pouvoir en démarrer une.
    if (cfg('showWorkspaceFolders', true)) {
      for (const f of vscode.workspace.workspaceFolders ?? []) {
        const p = f.uri.fsPath;
        if (!this.groups.some((g) => g.project === p)) this.groups.push({ project: p, sessions: [], liveCount: 0, busyCount: 0, waitingCount: 0 });
      }
    }
    this.terminals.clear();
    for (let i = pendingNew.length - 1; i >= 0; i--) {
      if (pendingNew[i].term.exitStatus !== undefined || Date.now() - pendingNew[i].at > 600_000) pendingNew.splice(i, 1);
    }
    for (const g of this.groups) for (const s of g.sessions) {
      let t = (s.live ? terminalFor(s.live, pids, procs) : undefined) ?? ownTerminals.get(s.sessionId);
      if (!t && s.live) {
        const i = pendingNew.findIndex((p) => samePath(p.project, s.project) && (s.live!.startedAt ?? Date.now()) >= p.at - 5000);
        if (i >= 0) { t = pendingNew[i].term; ownTerminals.set(s.sessionId, t); pendingNew.splice(i, 1); }
      }
      if (t && t.exitStatus === undefined) this.terminals.set(s.sessionId, t);
    }
    this.shared = cfg('warnSharedRepository', true) ? sharedRepositories(this.groups) : new Map();
    this.syncSelection();
    this.post();
    this.onChanged();
    this.notifyTransitions();
    this.warnSharedRepositories();
    for (const g of this.groups) if (g.liveCount) void openGitRepository(g.project);
  }

  /**
   * Prévient quand une session termine son travail ou attend une validation, sauf si son terminal est le
   * terminal actif d'une fenêtre au premier plan (l'API ne dit pas si le focus est dans le terminal lui-même).
   */
  private notifyTransitions(): void {
    const previous = this.lastStatus;
    this.lastStatus = new Map();
    for (const g of this.groups) for (const s of g.sessions) {
      if (!s.live) continue;
      const now = liveStatus(s.live);
      this.lastStatus.set(s.sessionId, now);
      const change = notableTransition(previous.get(s.sessionId), now);
      if (!change) continue;
      const term = this.terminals.get(s.sessionId);
      const skip = !cfg('notifications', true) ? 'notifications désactivées'
        // Chaque fenêtre VS Code fait tourner sa propre instance de l'extension : seule celle du terminal prévient.
        : !term ? 'session hors des terminaux de cette fenêtre'
        : vscode.window.state.focused && vscode.window.activeTerminal === term ? 'son terminal est actif, fenêtre au premier plan'
        : undefined;
      log.info(`${s.sessionId} « ${s.title} » ${previous.get(s.sessionId)} -> ${now} : ${skip ? `pas de notification (${skip})` : 'notification'}`);
      if (skip) continue;
      const where = baseName(s.project);
      const shown = change === 'waiting'
        ? vscode.window.showWarningMessage(`« ${s.title} » attend une validation (${where}).`, 'Afficher')
        : vscode.window.showInformationMessage(`Claude a terminé : « ${s.title} » (${where}).`, 'Afficher');
      void shown.then((choice) => { if (choice === 'Afficher') void this.openSession(s); });
    }
  }

  /**
   * Prévient quand plusieurs sessions travaillent dans le même dépôt (cf. une session qui en efface le travail
   * non commité d'une autre). Seulement si l'une d'elles tourne dans cette fenêtre, pour ne pas prévenir partout.
   */
  private warnSharedRepositories(): void {
    for (const [root, sessions] of this.shared) {
      const key = `${root}|${sessions.map((s) => s.sessionId).sort().join(',')}`;
      if (this.warnedShared.has(key) || !sessions.some((s) => this.terminals.has(s.sessionId))) continue;
      this.warnedShared.add(key);
      const titles = sessions.map((s) => `« ${s.title} »`).join(', ');
      log.info(`dépôt partagé ${root} : ${sessions.map((s) => s.sessionId).join(', ')}`);
      void vscode.window.showWarningMessage(
        `${sessions.length} sessions Claude travaillent dans le même dépôt (${path.basename(root)}) : ${titles}. `
        + `Elles risquent d'écraser le travail non commité l'une de l'autre ; un worktree par session évite le problème.`,
      );
    }
  }

  /** Surligne la session dont le terminal est actif. */
  syncSelection(): void {
    const active = vscode.window.activeTerminal;
    let found: string | null = null;
    if (active) for (const [id, t] of this.terminals) if (t === active) { found = id; break; }
    this.selectedId = found;
  }

  private post(): void {
    if (!this.view) return;
    const hideAfter = cfg('hideInactiveAfterHours', 48);
    const roots = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
    const sharedWith = new Map<string, string[]>();
    for (const sessions of this.shared.values()) for (const s of sessions) {
      sharedWith.set(s.sessionId, sessions.filter((o) => o !== s).map((o) => o.title));
    }
    const groups: WireGroup[] = this.groups.map((g) => ({
      project: g.project, liveCount: g.liveCount, busyCount: g.busyCount, waitingCount: g.waitingCount,
      // Les dossiers ouverts dans la fenêtre restent visibles même sans activité récente.
      inactive: !roots.has(g.project) && isInactive(g, hideAfter),
      windows: isForeign(g.project),
      sessions: g.sessions.map((s) => ({
        sessionId: s.sessionId, title: s.title, lastPrompt: s.lastPrompt, lastActivity: s.lastActivity, promptCount: s.promptCount,
        live: s.live ? { pid: s.live.pid, busy: isBusy(s.live), waiting: isWaiting(s.live) } : undefined,
        inThisWindow: this.terminals.has(s.sessionId),
        inactive: isInactiveSession(s, hideAfter),
        sharedWith: sharedWith.get(s.sessionId),
      })),
    }));
    void this.view.webview.postMessage({
      type: 'state', groups, selectedId: this.selectedId, showPast: cfg('showPastSessions', true), hideAfter, changes: this.changesFor(this.selectedId),
    });
    const live = this.groups.reduce((n, g) => n + g.liveCount, 0);
    this.view.badge = live ? { value: live, tooltip: `${live} session(s) active(s)` } : undefined;
  }

  /** Fichiers modifiés du dépôt de la session sélectionnée, d'après l'extension Git (donc à jour en continu). */
  private changesFor(id: string | null): WireChanges | undefined {
    const s = id ? this.find(id) : undefined;
    const repo = s && !isForeign(s.project) && cfg('showChangedFiles', true) ? this.git?.getRepository(vscode.Uri.file(s.project)) : undefined;
    if (!s || !repo) return undefined;
    const st = repo.state;
    const files = mergeChanges([st.mergeChanges, st.workingTreeChanges, st.untrackedChanges ?? [], st.indexChanges]
      .map((group) => group.map((c) => ({ path: c.uri.fsPath, status: c.status }))));
    const root = repo.rootUri.fsPath;
    return {
      sessionId: s.sessionId, repo: path.basename(root), total: files.length,
      files: files.slice(0, MAX_CHANGED_FILES).map((f) => ({ abs: f.path, rel: path.relative(root, f.path), letter: f.letter })),
    };
  }

  private find(id?: string): SessionInfo | undefined {
    for (const g of this.groups) for (const s of g.sessions) if (s.sessionId === id) return s;
    return undefined;
  }

  async openSession(s: SessionInfo): Promise<void> {
    // Un dossier Windows vu de WSL n'est pas dans l'espace de travail : ni explorateur ni dépôt à ouvrir.
    if (!isForeign(s.project)) {
      if (cfg('revealProjectOnClick', true)) await revealProject(s.project);
      void openGitRepository(s.project);
    }
    let term = this.terminals.get(s.sessionId);
    if (term && term.exitStatus !== undefined) term = undefined;
    if (!term && s.live) {
      const choice = await vscode.window.showWarningMessage(
        `« ${s.title} » tourne déjà ailleurs (pid ${s.live.pid}), pas dans un terminal de cette fenêtre.`,
        'Reprendre ici quand même', 'Annuler',
      );
      if (choice !== 'Reprendre ici quand même') return;
    }
    term ??= resumeInTerminal(s);
    if (!term) return;
    this.terminals.set(s.sessionId, term);
    this.selectedId = s.sessionId;
    this.post();
    term.show(false);
  }

  /**
   * Termine une session vivante par SIGTERM : Claude s'arrête proprement (moins d'une seconde, et il retire
   * lui-même son entrée du registre). Elle reste reprenable depuis la liste, comme toute session passée.
   */
  async stopSession(s: SessionInfo): Promise<void> {
    if (!s.live) return;
    const term = this.terminals.get(s.sessionId);
    const windows = isWindowsPath(s.live.cwd);
    const detail = (isBusy(s.live) ? 'Elle est en train de travailler : ce qu\'elle fait sera interrompu. ' : '')
      + (windows ? 'Sous Windows, l\'arrêt est immédiat : Claude n\'a pas le temps de se fermer proprement. ' : '')
      + 'Elle pourra être reprise plus tard depuis la liste.';
    const STOP = 'Terminer', STOP_CLOSE = 'Terminer et fermer le terminal';
    const choice = await vscode.window.showWarningMessage(`Terminer la session « ${s.title} » ?`, { modal: true, detail }, ...(term ? [STOP, STOP_CLOSE] : [STOP]));
    if (!choice) return;
    if (windows) return this.stopWindowsSession(s, s.live, choice === STOP_CLOSE ? term : undefined);
    // Entre le relevé et la confirmation, le processus a pu se terminer et son pid être réattribué.
    if (!isSessionAlive(s.live)) { void this.refresh(); return; }
    try {
      process.kill(s.live.pid, 'SIGTERM');
    } catch (e) {
      void vscode.window.showErrorMessage(`Impossible de terminer « ${s.title} » : ${e}`);
      return;
    }
    log.info(`${s.sessionId} « ${s.title} » : SIGTERM envoyé au pid ${s.live.pid}`);
    if (choice === STOP_CLOSE) term?.dispose();
    const live = s.live;
    for (let i = 0; i < 25 && isSessionAlive(live); i++) await new Promise((r) => setTimeout(r, 200));
    if (isSessionAlive(live)) {
      const force = await vscode.window.showWarningMessage(`« ${s.title} » ne s'est pas arrêtée après 5 s.`, 'Forcer l\'arrêt');
      if (force && isSessionAlive(live)) process.kill(live.pid, 'SIGKILL');
    }
    void this.refresh();
  }

  /** Pas de SIGTERM sous Windows pour un programme console : taskkill /F, après un relevé frais. */
  private async stopWindowsSession(s: SessionInfo, live: LiveSession, closeTerm?: vscode.Terminal): Promise<void> {
    const procs = await this.winProcs.snapshot({ maxAgeMs: 0, waitMs: 30_000 });
    if (!procs) { void vscode.window.showErrorMessage('Impossible de lister les processus Windows : session non terminée.'); return; }
    if (!winSessionAlive(live, procs)) { void this.refresh(); return; }
    try {
      await killWindowsProcess(live.pid);
    } catch (e) {
      void vscode.window.showErrorMessage(`Impossible de terminer « ${s.title} » : ${e instanceof Error ? e.message : e}`);
      return;
    }
    log.info(`${s.sessionId} « ${s.title} » : taskkill /F sur le pid Windows ${live.pid}`);
    closeTerm?.dispose();
    void this.refresh();
  }

  startNewSession(project: string): void {
    newSessionInTerminal(project)?.show(false);
    setTimeout(() => void this.refresh(), 2000);
  }

  /** Choix du dossier pour une nouvelle session : espace de travail, projets connus, ou parcourir. */
  async pickProjectAndStart(): Promise<void> {
    type Item = vscode.QuickPickItem & { project?: string; browse?: boolean; browseWindows?: boolean };
    const ws = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const known = this.groups.map((g) => g.project).filter((p) => !ws.includes(p) && !isForeign(p) && fs.existsSync(p));
    const items: Item[] = [];
    if (ws.length) {
      items.push({ label: 'Espace de travail', kind: vscode.QuickPickItemKind.Separator });
      items.push(...ws.map((p) => ({ label: `$(root-folder) ${path.basename(p)}`, description: p, project: p })));
    }
    if (known.length) {
      items.push({ label: 'Projets connus', kind: vscode.QuickPickItemKind.Separator });
      items.push(...known.map((p) => ({ label: `$(history) ${path.basename(p)}`, description: p, project: p })));
    }
    if (this.windowsDir) {
      const winKnown = this.groups.map((g) => g.project).filter(isForeign);
      items.push({ label: 'Windows', kind: vscode.QuickPickItemKind.Separator });
      items.push(...winKnown.map((p) => ({ label: `$(window) ${baseName(p)}`, description: p, project: p })));
      items.push({ label: '$(window) Parcourir un dossier Windows…', browseWindows: true });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(folder-opened) Parcourir un dossier…', browse: true });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Dans quel dossier démarrer la nouvelle session Claude ?', matchOnDescription: true });
    if (!pick) return;
    let project = pick.project;
    if (pick.browse) {
      const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Démarrer Claude ici' });
      project = chosen?.[0]?.fsPath;
    }
    if (pick.browseWindows && this.windowsDir) {
      const chosen = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Démarrer Claude ici (Windows)',
        defaultUri: vscode.Uri.file(path.dirname(this.windowsDir)),
      });
      if (!chosen?.[0]) return;
      project = wslToWin(chosen[0].fsPath);
      if (!project) { void vscode.window.showErrorMessage('Choisir un dossier d\'un disque Windows (sous /mnt/<lecteur>).'); return; }
    }
    if (project) this.startNewSession(project);
  }

  private async onMessage(m: { type: string; id?: string; project?: string; path?: string }): Promise<void> {
    const s = this.find(m.id);
    switch (m.type) {
      case 'ready': case 'refresh': await this.refresh(); break;
      case 'open': if (s) await this.openSession(s); break;
      case 'stop': if (s?.live) await this.stopSession(s); break;
      case 'reveal': if (m.project) await revealProject(m.project); break;
      case 'newWindow': if (m.project) await revealProject(m.project, 'newWindow'); break;
      case 'newSession': if (m.project) this.startNewSession(m.project); break;
      // Même diff qu'un clic dans la vue Contrôle de code source (non suivi : le fichier ; supprimé : la version HEAD).
      case 'openChange': if (m.path) await vscode.commands.executeCommand('git.openChange', vscode.Uri.file(m.path)); break;
      case 'showScm': await vscode.commands.executeCommand('workbench.view.scm'); break;
      case 'pickNewSession': await vscode.commands.executeCommand('claudeSessions.newSession'); break;
      case 'togglePast': await vscode.workspace.getConfiguration('claudeSessions').update('showPastSessions', !cfg('showPastSessions', true), vscode.ConfigurationTarget.Global); break;
    }
  }

  private html(webview: vscode.Webview): string {
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f));
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('view.css')}">
<title>Sessions Claude</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${media('view.js')}"></script></body></html>`;
  }
}

// ---------- Activation ----------

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('Claude Sessions', { log: true });
  context.subscriptions.push(log);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = `${VIEW_ID}.focus`;

  const view = new SessionsView(context, () => {
    const live = view.groups.reduce((n, g) => n + g.liveCount, 0);
    const busy = view.groups.reduce((n, g) => n + g.busyCount, 0);
    const waiting = view.groups.reduce((n, g) => n + g.waitingCount, 0);
    status.text = waiting ? `$(bell-dot) Claude ${waiting} à valider` : busy ? `$(sync~spin) Claude ${busy}/${live}` : `$(hubot) Claude ${live}`;
    status.backgroundColor = waiting ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    status.tooltip = `${live} session(s) Claude Code active(s), ${busy} en cours de travail, ${waiting} en attente de validation`;
    status.show();
  });

  const DOCK_KEY = 'dockedToTerminal.v1';
  if (!context.globalState.get<boolean>(DOCK_KEY)) {
    setTimeout(async () => { if (await dockToTerminal()) await context.globalState.update(DOCK_KEY, true); }, 1500);
  }

  const refresh = () => void view.refresh();
  let timer: NodeJS.Timeout | undefined;
  const debounced = () => { if (timer) clearTimeout(timer); timer = setTimeout(refresh, 250); };

  // Fenêtre WSL : sessions Windows lues dans %USERPROFILE%\.claude par /mnt (sans surveillance de fichiers,
  // qui ne voit pas les écritures faites côté Windows : le sondage s'en charge).
  const resolveWindowsDir = async () => {
    const configured = cfg('windowsClaudeDir', '').trim();
    const dir = !isWsl() || !cfg('includeWindowsSessions', true) ? undefined
      : configured ? (winToWsl(configured) ?? configured) : await windowsClaudeDirFromWsl();
    view.windowsDir = dir && fs.existsSync(dir) ? dir : undefined;
    if (!view.windowsDir) view.winProcs.dispose();
    log.info(`sessions Windows : ${view.windowsDir ?? 'non affichées'}`);
    debounced();
  };
  void resolveWindowsDir();
  context.subscriptions.push({ dispose: () => view.winProcs.dispose() });

  // Chaque changement de fichier vu par l'extension Git rafraîchit la liste des fichiers modifiés.
  void gitApi().then((git) => {
    if (!git) return;
    view.git = git;
    const watch = (r: GitRepository) => context.subscriptions.push(r.state.onDidChange(debounced));
    git.repositories.forEach(watch);
    context.subscriptions.push(git.onDidOpenRepository((r) => { watch(r); debounced(); }));
    debounced();
  });

  const root = claudeDir();
  for (const dir of [path.join(root, 'sessions'), root]) {
    try {
      const w = fs.watch(dir, (_e, file) => { if (dir === root && file !== 'history.jsonl') return; debounced(); });
      context.subscriptions.push({ dispose: () => w.close() });
    } catch { /* dossier absent : le polling suffit */ }
  }
  let poll = setInterval(refresh, cfg('pollIntervalSeconds', 5) * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });

  context.subscriptions.push(
    status,
    vscode.window.registerWebviewViewProvider(VIEW_ID, view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('claudeSessions.refresh', refresh),
    vscode.commands.registerCommand('claudeSessions.newSession', () => view.pickProjectAndStart()),
    vscode.commands.registerCommand('claudeSessions.dockToTerminal', async () => {
      if (!(await dockToTerminal())) void vscode.window.showWarningMessage('Impossible de déplacer la vue dans le panneau Terminal.');
    }),
    vscode.window.onDidChangeActiveTerminal(() => debounced()),
    vscode.window.onDidCloseTerminal((t) => { for (const [k, term] of ownTerminals) if (term === t) ownTerminals.delete(k); debounced(); }),
    vscode.window.onDidOpenTerminal(() => setTimeout(debounced, 1500)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeSessions')) return;
      if (e.affectsConfiguration('claudeSessions.includeWindowsSessions') || e.affectsConfiguration('claudeSessions.windowsClaudeDir')) void resolveWindowsDir();
      clearInterval(poll);
      poll = setInterval(refresh, cfg('pollIntervalSeconds', 5) * 1000);
      refresh();
    }),
  );

  refresh();
}

export function deactivate(): void {}
