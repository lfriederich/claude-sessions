# Claude Sessions

Extension VS Code qui affiche les sessions Claude Code (en cours et récentes) directement dans le panneau
Terminal, en permanence à côté des terminaux, regroupées par projet. Au premier démarrage la vue est déplacée
automatiquement dans le panneau Terminal (commande interne `vscode.moveViews`) ; la commande
« Placer la liste des sessions à côté du terminal » permet de refaire ce placement si on l'a déplacée.

- **Clic sur une session** : affiche le terminal où elle tourne. Si la session est terminée, un terminal
  est ouvert dans son projet avec `claude --resume <id>`. Le dossier du projet est aussi révélé dans
  l'explorateur (désactivable via `claudeSessions.revealProjectOnClick`).
- **Terminal actif → session surlignée** : changer de terminal sélectionne la session correspondante.
- **Disposition** : la liste et le terminal se partagent le panneau Terminal. La séparation se redimensionne
  et la liste peut être glissée à gauche ou à droite du terminal ; VS Code mémorise la disposition.
- **Barre d'état** : nombre de sessions actives, et combien sont en train de travailler.

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
- La détection du terminal qui héberge une session repose sur `/proc` : Linux et WSL uniquement. Sous
  Windows natif ou macOS, la liste, les statuts et la reprise fonctionnent, mais un clic sur une session
  vivante ne retrouve pas son terminal et propose de la reprendre dans un nouveau.
