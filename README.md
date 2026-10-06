# Claude Sessions

Extension VS Code qui affiche les sessions Claude Code (en cours et récentes) directement dans le panneau
Terminal, en permanence à côté des terminaux, regroupées par projet. Au premier démarrage la vue est déplacée
automatiquement dans le panneau Terminal (commande interne `vscode.moveViews`) ; la commande
« Placer la liste des sessions à côté du terminal » permet de refaire ce placement si on l'a déplacée.

- **Clic sur une session** : affiche le terminal où elle tourne. Si la session est terminée, un terminal
  est ouvert dans son projet avec `claude --resume <id>`. Le dossier du projet est aussi révélé dans
  l'explorateur (désactivable via `claudeSessions.revealProjectOnClick`).
- **Fichiers modifiés dans l'explorateur** : le dépôt git de chaque projet qui a une session active (ou qu'on
  clique) est ouvert dans l'extension Git de VS Code, même s'il est trop profond sous le dossier ouvert pour être
  détecté (`git.repositoryScanMaxDepth` vaut 1). Ses fichiers modifiés apparaissent alors dans l'arborescence.
  Désactivable via `claudeSessions.openGitRepositories`.
- **Terminer une session active** : bouton carré au survol de la session, ou touche Suppr quand elle a le focus.
  Après confirmation, Claude reçoit SIGTERM et s'arrête proprement ; si son terminal est dans la fenêtre, on
  peut aussi le fermer. La session reste reprenable depuis la liste. Si elle ne s'est pas arrêtée après 5 s,
  une notification propose de forcer l'arrêt.
- **Terminal actif → session surlignée** : changer de terminal sélectionne la session correspondante.
- **Disposition** : la liste et le terminal se partagent le panneau Terminal. La séparation se redimensionne
  et la liste peut être glissée à gauche ou à droite du terminal ; VS Code mémorise la disposition.
- **Session qui attend une validation** (demande de permission ou question de Claude) : point orange,
  en tête de son projet, et la barre d'état passe en « N à valider » sur fond d'avertissement.
- **Notifications** : quand une session qui tourne dans un terminal de la fenêtre termine son travail ou attend
  une validation, une notification le signale (bouton « Afficher » pour aller à son terminal), sauf si ce terminal
  est déjà le terminal actif d'une fenêtre au premier plan. Désactivable via `claudeSessions.notifications`.
  Le panneau Sortie « Claude Sessions » note chaque changement de statut détecté et la décision prise.
- **Fichiers modifiés de la session** : sous la session sélectionnée (celle du terminal actif), la liste des
  fichiers modifiés de son dépôt git, lue dans l'extension Git de VS Code et donc à jour en continu ; elle suit le
  changement de session. Un clic ouvre le même diff que dans la vue Contrôle de code source. Au-delà de 15
  fichiers, un lien ouvre cette vue. Désactivable via `claudeSessions.showChangedFiles`.
- **Dépôt partagé** : quand plusieurs sessions actives travaillent dans le même dépôt git (racine commune, même
  depuis des sous-dossiers différents), elles portent un badge « ⚠ dépôt partagé » et une notification le signale
  une fois. Deux worktrees distincts ne comptent pas : c'est la parade. Désactivable via
  `claudeSessions.warnSharedRepository`.
- **Barre d'état** : nombre de sessions actives, et combien sont en train de travailler.
- **Inactif masqué** : une session terminée depuis plus de 48 h (`claudeSessions.hideInactiveAfterHours`,
  0 pour tout afficher) disparaît de la liste, et avec elle un projet qui n'a plus rien de récent, sauf s'il est
  ouvert dans la fenêtre. Les sessions actives restent toujours visibles. Taper le nom d'un dossier dans le
  filtre fait réapparaître ce projet avec toutes ses sessions.

## Sessions Windows

- **VS Code lancé directement sous Windows** : la liste, les statuts, la reprise, l'arrêt et la détection du
  terminal d'une session fonctionnent. Sans `/proc`, l'extension lit l'arbre des processus Windows par un
  PowerShell qu'elle garde ouvert, lancé seulement quand des sessions sont actives.
- **Fenêtre VS Code connectée à WSL** : les sessions Claude Code de Windows (`%USERPROFILE%\.claude`) s'affichent
  aussi, avec une pastille « Windows ». Le bouton « + » propose une section Windows (projets Windows connus,
  ou « Parcourir un dossier Windows… ») ; ces sessions, comme les reprises de sessions Windows, s'ouvrent dans un
  terminal `cmd.exe` lancé par l'interop WSL. Il faut que Claude Code soit installé **sous Windows**.
  Réglages : `claudeSessions.includeWindowsSessions`, `windowsClaudeDir`, `windowsClaudeCommand`.
- Arrêter une session Windows est immédiat (`taskkill /F`) : il n'y a pas d'équivalent à SIGTERM pour un programme
  console Windows.
- Le premier relevé des processus Windows peut prendre 5 à 10 s (démarrage de PowerShell) : les sessions Windows
  actives n'apparaissent qu'ensuite. Les suivants prennent environ 0,2 s.

## Installation sur un autre poste

L'extension doit tourner **là où tourne Claude Code**, car elle lit `~/.claude` :

- Claude Code dans WSL : installer l'extension dans une fenêtre VS Code connectée à WSL (indicateur vert
  « WSL: … » en bas à gauche).
- Claude Code sous Windows ou macOS directement : installer l'extension dans une fenêtre VS Code locale.

### 1. Récupérer le fichier .vsix

Le dépôt est privé : il faut être connecté à GitHub avec le compte `lfriederich`.

- **Par le site** : page *Releases* du dépôt, télécharger `claude-sessions-<version>.vsix`.
- **En ligne de commande**, avec [GitHub CLI](https://cli.github.com/) :

```bash
gh auth login --web --git-protocol https     # une seule fois par poste
gh release download --repo lfriederich/claude-sessions --pattern '*.vsix'
```

### 2. Installer

```bash
code --install-extension claude-sessions-0.1.0.vsix
```

Ou dans VS Code : vue Extensions, menu `…`, « Install from VSIX… ».

Recharger ensuite la fenêtre (`Ctrl+Shift+P` → « Developer: Reload Window »).

### 3. Au premier démarrage

- La vue « Sessions Claude » se place d'elle-même dans le panneau Terminal, à côté des terminaux.
  Si elle atterrit ailleurs, le bouton « Replacer à côté du terminal » de son en-tête la remet en place.
- Optionnel : masquer la liste native des onglets de terminal, qui fait doublon. Dans les paramètres
  utilisateur (`Ctrl+Shift+P` → « Preferences: Open User Settings (JSON) ») :

```json
"terminal.integrated.tabs.enabled": false
```

### Mettre à jour

Télécharger le nouveau `.vsix` et relancer `code --install-extension` : il remplace l'ancienne version.

### Compiler soi-même (au lieu du .vsix publié)

Nécessite Node 18 ou plus récent.

```bash
gh repo clone lfriederich/claude-sessions
cd claude-sessions
npm ci
npm run package      # tests, build, puis claude-sessions-<version>.vsix
```

## Sources de données

- `~/.claude/sessions/*.json` : registre des processus Claude Code vivants (dossier, nom, statut).
- `~/.claude/history.jsonl` : prompts passés, pour reconstituer les sessions terminées.

Rien n'est envoyé nulle part : lecture locale uniquement.

## Développement

```bash
npm install
npm test          # tests unitaires de la logique (node --test)
npm run build     # bundle dist/extension.js
npm run package   # produit claude-sessions-x.y.z.vsix
code --install-extension claude-sessions-*.vsix
```

F5 dans VS Code lance une fenêtre de développement avec l'extension chargée.

## Limites

- Ajouter un dossier à une fenêtre mono-dossier la transforme en espace de travail multi-racines,
  ce qui recharge la fenêtre une fois (comportement VS Code).
- La détection du terminal qui héberge une session repose sur `/proc` (Linux, WSL) ou sur l'arbre des processus
  Windows. Sous macOS, la liste, les statuts et la reprise fonctionnent, mais un clic sur une session vivante ne
  retrouve pas son terminal et propose de la reprendre dans un nouveau.
- Depuis WSL, une session Windows n'est rattachée à un terminal que si l'extension l'a lancée ou reprise : une
  session démarrée dans un terminal Windows apparaît comme tournant « ailleurs ».
