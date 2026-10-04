// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  /** @type {Set<string>} */
  const collapsed = new Set(saved.collapsed || []);
  /** @type {Set<string>} */
  const expanded = new Set(saved.expanded || []);
  let query = '';
  let state = { groups: [], selectedId: null, showPast: true, hideAfter: 0 };
  /** Dernière session ramenée à l'écran : on ne recentre que si la sélection change. */
  let revealedId = null;
  /** Dernier état reçu, sérialisé : le sondage renvoie souvent le même, inutile de tout redessiner. */
  let lastState = '';

  const I = {
    chev: '<svg class="chev" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 6l3.5 3.5L11.5 6l.7.7-4.2 4.2-4.2-4.2z"/></svg>',
    terminal: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9zM3.5 3a.5.5 0 00-.5.5v9a.5.5 0 00.5.5h9a.5.5 0 00.5-.5v-9a.5.5 0 00-.5-.5h-9zm1.1 2.1l.7-.7L8.1 7.2l-2.8 2.8-.7-.7L6.7 7.2 4.6 5.1zM8 10h3.5v1H8v-1z"/></svg>',
    folder: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3A1.5 1.5 0 013 1.5h3.2l1.6 1.5H13A1.5 1.5 0 0114.5 4.5v8A1.5 1.5 0 0113 14H3a1.5 1.5 0 01-1.5-1.5V3zM3 2.5a.5.5 0 00-.5.5v9.5a.5.5 0 00.5.5h10a.5.5 0 00.5-.5V4.5a.5.5 0 00-.5-.5H7.4L5.8 2.5H3z"/></svg>',
    plus: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 2h1v5.5H14v1H8.5V14h-1V8.5H2v-1h5.5V2z"/></svg>',
    window: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3A1.5 1.5 0 013 1.5h10A1.5 1.5 0 0114.5 3v10a1.5 1.5 0 01-1.5 1.5H3A1.5 1.5 0 011.5 13V3zM3 2.5a.5.5 0 00-.5.5v1.5h11V3a.5.5 0 00-.5-.5H3zm10.5 3h-11V13a.5.5 0 00.5.5h10a.5.5 0 00.5-.5V5.5z"/></svg>',
    eye: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 3c3.6 0 6.3 2.9 7 5-.7 2.1-3.4 5-7 5s-6.3-2.9-7-5c.7-2.1 3.4-5 7-5zm0 1C5.1 4 2.8 6.3 2.1 8 2.8 9.7 5.1 12 8 12s5.2-2.3 5.9-4C13.2 6.3 10.9 4 8 4zm0 1.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5z"/></svg>',
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

  function relative(ts) {
    const m = Math.floor(Math.max(0, Date.now() - ts) / 60000);
    if (m < 1) return "à l'instant";
    if (m < 60) return `il y a ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `il y a ${h} h`;
    const d = Math.floor(h / 24);
    if (d < 30) return `il y a ${d} j`;
    return new Date(ts).toLocaleDateString('fr-FR');
  }

  function isOpen(g) {
    if (collapsed.has(g.project)) return false;
    if (expanded.has(g.project)) return true;
    return g.liveCount > 0 || g.sessions.length === 0;
  }

  function btn(action, title, icon, extra = '') {
    const on = extra.includes('data-on');
    return `<button class="iconbtn${on ? ' on' : ''}" data-action="${action}" title="${esc(title)}" ${extra}>${I[icon]}</button>`;
  }

  function render() {
    const app = document.getElementById('app');
    const q = query.trim().toLowerCase();
    // Projets et sessions terminées inactifs n'apparaissent que si on cherche leur dossier.
    const folderMatch = (g) => !!q && g.project.toLowerCase().includes(q);
    const visible = state.groups.filter((g) => !g.inactive || folderMatch(g));
    const hidden = q ? 0 : state.groups.length - visible.length;
    const groups = visible
      .map((g) => ({ ...g, total: g.sessions.length, sessions: g.sessions.filter((s) => (!s.inactive || folderMatch(g)) && (!q || `${s.title} ${s.lastPrompt} ${g.project}`.toLowerCase().includes(q))) }))
      .filter((g) => g.sessions.length || (!q && !g.liveCount));

    let html = `
      <div class="toolbar">
        ${btn('pickNewSession', 'Nouvelle session Claude…', 'plus')}
        <input id="q" type="text" placeholder="Filtrer les sessions…" value="${esc(query)}" />
        ${btn('togglePast', state.showPast ? 'Masquer les sessions terminées' : 'Afficher les sessions terminées', 'eye', state.showPast ? 'data-on="1"' : '')}
      </div>
      <div class="list">`;

    if (!groups.length && !hidden) {
      html += `<div class="empty">${q ? 'Aucune session ne correspond.' : 'Aucune session Claude Code trouvée.'}<br/><a data-action="refresh">Rafraîchir</a></div>`;
    }

    for (const g of groups) {
      const open = isOpen(g) || q;
      const idle = g.liveCount - g.busyCount - g.waitingCount;
      html += `<section class="project ${open ? '' : 'collapsed'}" data-project="${esc(g.project)}">
        <div class="project-head" title="${esc(g.project)}">
          ${I.chev}<span class="name">${esc(base(g.project))}</span>
          ${g.waitingCount ? `<span class="pill waiting">${g.waitingCount} à valider</span>` : ''}
          ${g.busyCount ? `<span class="pill busy">${g.busyCount} en cours</span>` : ''}
          ${idle ? `<span class="pill idle">${idle} en attente</span>` : ''}
          <span class="acts">
            ${btn('newSession', 'Nouvelle session Claude ici', 'plus', `data-project="${esc(g.project)}"`)}
            ${btn('reveal', "Révéler dans l'explorateur", 'folder', `data-project="${esc(g.project)}"`)}
            ${btn('newWindow', 'Ouvrir dans une nouvelle fenêtre', 'window', `data-project="${esc(g.project)}"`)}
          </span>
        </div>
        <div class="sessions">`;
      if (!g.sessions.length) {
        html += `<div class="session none" data-action="newSession" data-project="${esc(g.project)}" title="Démarrer une session Claude dans ce dossier">
          <div class="dot">${I.plus}</div>
          <div class="body"><div class="title">${g.total ? 'Aucune session récente' : 'Aucune session'}</div><div class="meta"><span>cliquer pour en démarrer une</span></div></div>
        </div>`;
      }
      for (const s of g.sessions) {
        const cls = s.live ? (s.live.waiting ? 'live-waiting' : s.live.busy ? 'live-busy' : 'live-idle') : 'past';
        const status = s.live ? (s.live.waiting ? 'attend une validation' : s.live.busy ? 'en cours' : 'en attente de réponse') : '';
        const meta = [
          status ? `<span class="status">${status}</span>` : '',
          `<span>${relative(s.lastActivity)}</span>`,
          !s.live && s.promptCount ? `<span>${s.promptCount} prompt${s.promptCount > 1 ? 's' : ''}</span>` : '',
          s.live && s.inThisWindow ? `<span class="here" title="Tourne dans un terminal de cette fenêtre">${I.terminal}</span>` : '',
          s.live && !s.inThisWindow ? `<span title="Tourne hors de cette fenêtre (pid ${s.live.pid})">ailleurs</span>` : '',
        ].filter(Boolean).join('<span class="sep"></span>');
        const tip = [s.title, s.lastPrompt && s.lastPrompt !== s.title ? `Dernier prompt : ${s.lastPrompt}` : '', `Session ${s.sessionId}`].filter(Boolean).join('\n');
        html += `<div class="session ${cls} ${s.sessionId === state.selectedId ? 'selected' : ''}" tabindex="0" data-id="${esc(s.sessionId)}" title="${esc(tip)}">
          <div class="dot"></div>
          <div class="body">
            <div class="title">${esc(s.title)}</div>
            <div class="meta">${meta}</div>
          </div>
        </div>`;
      }
      html += `</div></section>`;
    }
    if (hidden) {
      html += `<div class="hidden-note">${hidden} projet${hidden > 1 ? 's' : ''} sans activité depuis ${state.hideAfter} h masqué${hidden > 1 ? 's' : ''}.<br/>Taper le nom d'un dossier dans le filtre pour le retrouver.</div>`;
    }
    html += `</div>`;
    // innerHTML recrée tout : sans ça, chaque rendu (clic, sondage) remonte la liste en haut
    // et fait perdre le focus au filtre en pleine frappe ou à la session parcourue au clavier.
    const scrollTop = app.querySelector('.list')?.scrollTop ?? 0;
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    const caret = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
    const focusedId = active?.classList.contains('session') ? active.getAttribute('data-id') : null;
    app.innerHTML = html;
    app.querySelector('.list').scrollTop = scrollTop;

    const input = /** @type {HTMLInputElement} */ (document.getElementById('q'));
    input.addEventListener('input', () => { query = input.value; render(); });
    if (caret) { input.focus({ preventScroll: true }); input.setSelectionRange(caret[0], caret[1]); }
    else if (focusedId) /** @type {HTMLElement | null} */ (app.querySelector(`.session[data-id="${CSS.escape(focusedId)}"]`))?.focus({ preventScroll: true });
    const sel = app.querySelector('.session.selected');
    if (sel && state.selectedId !== revealedId) sel.scrollIntoView({ block: 'nearest' });
    revealedId = state.selectedId;
  }

  document.addEventListener('click', (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target);
    const actEl = t.closest('[data-action]');
    const sessEl = t.closest('.session');
    const headEl = t.closest('.project-head');
    if (actEl) {
      ev.stopPropagation();
      const action = actEl.getAttribute('data-action');
      const project = actEl.getAttribute('data-project') || sessEl?.closest('.project')?.getAttribute('data-project');
      const id = sessEl?.getAttribute('data-id');
      if (action === 'togglePast') { vscode.postMessage({ type: 'togglePast' }); return; }
      vscode.postMessage({ type: action, id, project });
      return;
    }
    if (sessEl) { vscode.postMessage({ type: 'open', id: sessEl.getAttribute('data-id') }); return; }
    if (headEl) {
      const p = headEl.parentElement.getAttribute('data-project');
      const g = state.groups.find((x) => x.project === p);
      if (isOpen(g)) { collapsed.add(p); expanded.delete(p); } else { expanded.add(p); collapsed.delete(p); }
      vscode.setState({ collapsed: [...collapsed], expanded: [...expanded] });
      render();
    }
  });
  document.addEventListener('keydown', (ev) => {
    const el = /** @type {HTMLElement} */ (document.activeElement);
    if (!el?.classList.contains('session')) return;
    if (ev.key === 'Enter') vscode.postMessage({ type: 'open', id: el.getAttribute('data-id') });
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const all = [...document.querySelectorAll('.session')];
      const i = all.indexOf(el) + (ev.key === 'ArrowDown' ? 1 : -1);
      /** @type {HTMLElement} */ (all[Math.max(0, Math.min(all.length - 1, i))])?.focus();
      ev.preventDefault();
    }
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type !== 'state') return;
    const key = JSON.stringify(msg);
    if (key === lastState) return;
    lastState = key;
    state = msg;
    render();
  });
  setInterval(render, 30_000); // rafraîchit les « il y a X min »
  vscode.postMessage({ type: 'ready' });
})();
