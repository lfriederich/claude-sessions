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
- La détection du terminal repose sur `/proc` : Linux et WSL uniquement.
