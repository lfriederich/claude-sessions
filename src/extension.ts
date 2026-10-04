import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LiveSession, ProjectGroup, SessionInfo, buildGroups, claudeDir, isBusy, parentPids, readHistory, readLiveSessions, truncate } from './model';

const VIEW_ID = 'claudeSessions.view';

function cfg<T>(key: string, def: T): T {
  return vscode.workspace.getConfiguration('claudeSessions').get<T>(key, def);
}

// ---------- Terminaux ----------

/** Terminaux ouverts par l'extension (reprise ou nouvelle session), indexés par session ou par projet. */
const ownTerminals = new Map<string, vscode.Terminal>();

async function terminalPids(): Promise<Map<number, vscode.Terminal>> {
  const map = new Map<number, vscode.Terminal>();
  await Promise.all(vscode.window.terminals.map(async (t) => {
    const pid = await t.processId;
    if (pid !== undefined) map.set(pid, t);
  }));
  return map;
}

function terminalFor(live: LiveSession, pids: Map<number, vscode.Terminal>): vscode.Terminal | undefined {
  for (const p of parentPids(live.pid)) {
    const t = pids.get(p);
    if (t) return t;
  }
  return undefined;
}

function createClaudeTerminal(key: string, name: string, cwd: string, command: string): vscode.Terminal {
  const existing = ownTerminals.get(key);
  if (existing && existing.exitStatus === undefined) return existing;
  const term = vscode.window.createTerminal({ name: truncate(name, 32), cwd, iconPath: new vscode.ThemeIcon('hubot') });
  term.sendText(command);
  ownTerminals.set(key, term);
  return term;
}

function resumeInTerminal(s: SessionInfo): vscode.Terminal {
  return createClaudeTerminal(s.sessionId, s.title || path.basename(s.project), s.project, `${cfg('claudeCommand', 'claude')} --resume ${s.sessionId}`);
}

function newSessionInTerminal(project: string): vscode.Terminal {
  return createClaudeTerminal(`new:${project}:${Date.now()}`, `claude · ${path.basename(project)}`, project, cfg('claudeCommand', 'claude'));
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
  sessionId: string; title: string; project: string; lastPrompt: string; lastActivity: number; promptCount: number;
  live?: { pid: number; busy: boolean; status?: string; name?: string; startedAt?: number };
  inThisWindow: boolean;
}
interface WireGroup { project: string; liveCount: number; busyCount: number; sessions: WireSession[] }

class SessionsView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  groups: ProjectGroup[] = [];
  private selectedId: string | null = null;
  private terminals = new Map<string, vscode.Terminal>(); // sessionId -> terminal hébergeant la session (cette fenêtre)

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
    this.groups = buildGroups(readLiveSessions(), readHistory(), {
      recentPerProject: cfg('recentPerProject', 5),
      showPast: cfg('showPastSessions', true),
    });
    // Les dossiers de l'espace de travail sans session apparaissent aussi, pour pouvoir en démarrer une.
    if (cfg('showWorkspaceFolders', true)) {
      for (const f of vscode.workspace.workspaceFolders ?? []) {
        const p = f.uri.fsPath;
        if (!this.groups.some((g) => g.project === p)) this.groups.push({ project: p, sessions: [], liveCount: 0, busyCount: 0 });
      }
    }
    this.terminals.clear();
    for (const g of this.groups) for (const s of g.sessions) {
      const t = s.live ? terminalFor(s.live, pids) : ownTerminals.get(s.sessionId);
      if (t && t.exitStatus === undefined) this.terminals.set(s.sessionId, t);
    }
    this.syncSelection();
    this.post();
    this.onChanged();
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
    const groups: WireGroup[] = this.groups.map((g) => ({
      project: g.project, liveCount: g.liveCount, busyCount: g.busyCount,
      sessions: g.sessions.map((s) => ({
        sessionId: s.sessionId, title: s.title, project: s.project, lastPrompt: s.lastPrompt, lastActivity: s.lastActivity, promptCount: s.promptCount,
        live: s.live ? { pid: s.live.pid, busy: isBusy(s.live), status: s.live.status, name: s.live.name, startedAt: s.live.startedAt } : undefined,
        inThisWindow: this.terminals.has(s.sessionId),
      })),
    }));
    void this.view.webview.postMessage({ type: 'state', groups, selectedId: this.selectedId, showPast: cfg('showPastSessions', true) });
    const live = this.groups.reduce((n, g) => n + g.liveCount, 0);
    this.view.badge = live ? { value: live, tooltip: `${live} session(s) active(s)` } : undefined;
  }

  private find(id?: string): SessionInfo | undefined {
    for (const g of this.groups) for (const s of g.sessions) if (s.sessionId === id) return s;
    return undefined;
  }

  async openSession(s: SessionInfo): Promise<void> {
    if (cfg('revealProjectOnClick', true)) await revealProject(s.project);
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
    this.terminals.set(s.sessionId, term);
    this.selectedId = s.sessionId;
    this.post();
    term.show(false);
  }

  startNewSession(project: string): void {
    newSessionInTerminal(project).show(false);
    setTimeout(() => void this.refresh(), 2000);
  }

  /** Choix du dossier pour une nouvelle session : espace de travail, projets connus, ou parcourir. */
  async pickProjectAndStart(): Promise<void> {
    type Item = vscode.QuickPickItem & { project?: string; browse?: boolean };
    const ws = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const known = this.groups.map((g) => g.project).filter((p) => !ws.includes(p) && fs.existsSync(p));
    const items: Item[] = [];
    if (ws.length) {
      items.push({ label: 'Espace de travail', kind: vscode.QuickPickItemKind.Separator });
      items.push(...ws.map((p) => ({ label: `$(root-folder) ${path.basename(p)}`, description: p, project: p })));
    }
    if (known.length) {
      items.push({ label: 'Projets connus', kind: vscode.QuickPickItemKind.Separator });
      items.push(...known.map((p) => ({ label: `$(history) ${path.basename(p)}`, description: p, project: p })));
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
    if (project) this.startNewSession(project);
  }

  private async onMessage(m: { type: string; id?: string; project?: string }): Promise<void> {
    const s = this.find(m.id);
    switch (m.type) {
      case 'ready': case 'refresh': await this.refresh(); break;
      case 'open': if (s) await this.openSession(s); break;
      case 'copy': if (s) await vscode.env.clipboard.writeText(s.sessionId); break;
      case 'reveal': if (m.project) await revealProject(m.project); break;
      case 'newWindow': if (m.project) await revealProject(m.project, 'newWindow'); break;
      case 'newSession': if (m.project) this.startNewSession(m.project); break;
      case 'pickNewSession': await vscode.commands.executeCommand('claudeSessions.newSession'); break;
      case 'togglePast': await vscode.workspace.getConfiguration('claudeSessions').update('showPastSessions', !cfg('showPastSessions', true), vscode.ConfigurationTarget.Global); break;
      case 'dock': await dockToTerminal(); break;
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
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = `${VIEW_ID}.focus`;

  const view = new SessionsView(context, () => {
    const live = view.groups.reduce((n, g) => n + g.liveCount, 0);
    const busy = view.groups.reduce((n, g) => n + g.busyCount, 0);
    status.text = busy ? `$(sync~spin) Claude ${busy}/${live}` : `$(hubot) Claude ${live}`;
    status.tooltip = `${live} session(s) Claude Code active(s), ${busy} en cours de travail`;
    status.show();
  });

  const DOCK_KEY = 'dockedToTerminal.v1';
  if (!context.globalState.get<boolean>(DOCK_KEY)) {
    setTimeout(async () => { if (await dockToTerminal()) await context.globalState.update(DOCK_KEY, true); }, 1500);
  }

  const refresh = () => void view.refresh();
  let timer: NodeJS.Timeout | undefined;
  const debounced = () => { if (timer) clearTimeout(timer); timer = setTimeout(refresh, 250); };

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
      clearInterval(poll);
      poll = setInterval(refresh, cfg('pollIntervalSeconds', 5) * 1000);
      refresh();
    }),
  );

  refresh();
}

export function deactivate(): void {}
