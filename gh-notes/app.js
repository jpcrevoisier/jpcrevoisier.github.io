// ===== GH Notes : éditeur de notes Markdown synchronisé avec un dépôt GitHub =====
// Le "commit + push" est réalisé via l'API REST (PUT /contents) : un appel = un commit poussé.

const $ = (s) => document.querySelector(s);
const LS_CFG = 'ghnotes.cfg';
const LS_OPEN = 'ghnotes.open';

let cfg = Object.assign({ repo: '', branch: '', token: '', msg: 'Mise à jour de {path}' },
  JSON.parse(localStorage.getItem(LS_CFG) || '{}'));
let branch = '';
let files = [];          // [{ path, sha }]
let cur = null;          // { path, sha, saved }
let dirty = false;
let saving = false;
let previewOn = false;
const openDirs = new Set(JSON.parse(localStorage.getItem(LS_OPEN) || '[]'));

// ---------- Utilitaires ----------
function setStatus(text, cls = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = cls;
}
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// ---------- API GitHub ----------
async function gh(url, opts = {}) {
  const full = 'https://api.github.com/repos/' + cfg.repo + url;
  const r = await fetch(full, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: 'Bearer ' + cfg.token,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!r.ok) {
    let m = '';
    try { m = (await r.json()).message; } catch (_) {}
    // Message plus explicite : code HTTP + chemin appelé
    const hint = r.status === 404
      ? ' (dépôt, branche ou droits du token ? appel : /repos/' + cfg.repo + url + ')'
      : '';
    const e = new Error((m || r.statusText) + hint);
    e.status = r.status;
    throw e;
  }
  return r.json();
}
// ---------- Chargement de l'arborescence ----------
async function loadTree() {
  if (!cfg.repo || !cfg.token) { openSettings(); return; }
  $('#repoName').textContent = cfg.repo;
  setStatus('Chargement…');
  try {
    branch = cfg.branch || (await gh('')).default_branch;
    const t = await gh('/git/trees/' + encodeURIComponent(branch) + '?recursive=1');
    files = t.tree
      .filter((x) => x.type === 'blob' && /\.(md|markdown)$/i.test(x.path))
      .map((x) => ({ path: x.path, sha: x.sha }));
    renderTree();
    setStatus(t.truncated ? 'Arborescence tronquée par GitHub' : files.length + ' note(s) — branche ' + branch,
      t.truncated ? 'warn' : '');
  } catch (e) {
    setStatus('Erreur : ' + e.message, 'err');
  }
}

// ---------- Rendu de l'arborescence ----------
function buildTree(list) {
  const root = { dirs: {}, files: [] };
  for (const f of list) {
    const parts = f.path.split('/');
    let n = root;
    for (let i = 0; i < parts.length - 1; i++) {
      n = n.dirs[parts[i]] || (n.dirs[parts[i]] = { dirs: {}, files: [] });
    }
    n.files.push(f);
  }
  return root;
}

function renderNode(node, base, forceOpen) {
  const ul = document.createElement('ul');
  Object.keys(node.dirs).sort((a, b) => a.localeCompare(b)).forEach((name) => {
    const p = base + name;
    const li = document.createElement('li');
    const d = document.createElement('details');
    d.open = forceOpen || openDirs.has(p);
    const s = document.createElement('summary');
    s.textContent = '📁 ' + name;
    d.append(s, renderNode(node.dirs[name], p + '/', forceOpen));
    d.addEventListener('toggle', () => {
      if (forceOpen) return;
      d.open ? openDirs.add(p) : openDirs.delete(p);
      localStorage.setItem(LS_OPEN, JSON.stringify([...openDirs]));
    });
    li.append(d);
    ul.append(li);
  });
  node.files.sort((a, b) => a.path.localeCompare(b.path)).forEach((f) => {
    const li = document.createElement('li');
    const div = document.createElement('div');
    div.className = 'file' + (cur && cur.path === f.path ? ' active' : '');
    div.textContent = '📝 ' + f.path.split('/').pop();
    div.title = f.path;
    div.addEventListener('click', () => openFile(f.path));
    li.append(div);
    ul.append(li);
  });
  return ul;
}

function renderTree() {
  const q = $('#filter').value.trim().toLowerCase();
  const list = q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  const tree = $('#tree');
  tree.replaceChildren();
  if (!list.length) {
    tree.innerHTML = '<div class="empty">Aucune note Markdown.</div>';
    return;
  }
  tree.append(renderNode(buildTree(list), '', !!q));
}

// ---------- Ouverture d'une note ----------
async function openFile(path) {
  if (cur && cur.path === path) return;
  if (dirty && !confirm('Modifications non enregistrées. Les abandonner ?')) return;
  const f = files.find((x) => x.path === path);
  if (!f) return;
  setStatus('Ouverture…');
  try {
    const blob = await gh('/git/blobs/' + f.sha);
    const text = b64ToUtf8(blob.content);
    cur = { path, sha: f.sha, saved: text };
    dirty = false;
    $('#editor').value = text;
    $('#editor').disabled = false;
    updateUI();
    renderTree();
    if (previewOn) renderPreview();
    $('#sidebar').classList.remove('open');
    setStatus('');
    if (!previewOn) $('#editor').focus();
  } catch (e) {
    setStatus('Erreur : ' + e.message, 'err');
  }
}

function updateUI() {
  $('#fileTitle').textContent = cur ? (dirty ? '● ' : '') + cur.path : 'Aucune note ouverte';
  document.title = cur ? (dirty ? '● ' : '') + cur.path + ' — GH Notes' : 'GH Notes';
  $('#btnSave').disabled = !(cur && dirty) || saving;
}

// ---------- Sauvegarde = commit + push ----------
async function save() {
  if (!cur || !dirty || saving) return;
  saving = true;
  updateUI();
  const value = $('#editor').value;
  setStatus('Commit en cours…');
  try {
    const res = await gh('/contents/' + encPath(cur.path), {
      method: 'PUT',
      body: JSON.stringify({
        message: (cfg.msg || 'Mise à jour de {path}').replace('{path}', cur.path),
        content: utf8ToB64(value),
        sha: cur.sha,
        branch,
      }),
    });
    cur.sha = res.content.sha;
    cur.saved = value;
    const entry = files.find((x) => x.path === cur.path);
    if (entry) entry.sha = cur.sha;
    dirty = $('#editor').value !== value;   // l'utilisateur a pu continuer à taper
    setStatus('Commit ' + res.commit.sha.slice(0, 7) + ' poussé ✔', 'ok');
  } catch (e) {
    if (e.status === 409 || e.status === 422) {
      setStatus('Conflit : la note a changé sur GitHub. Copiez votre texte puis rechargez.', 'err');
    } else {
      setStatus('Échec : ' + e.message, 'err');
    }
  } finally {
    saving = false;
    updateUI();
  }
}

// ---------- Nouvelle note ----------
async function newNote() {
  if (!cfg.repo || !cfg.token) { openSettings(); return; }
  let p = prompt('Chemin de la nouvelle note (ex : dossier/ma-note.md)');
  if (!p) return;
  p = p.trim().replace(/^\/+/, '');
  if (!/\.(md|markdown)$/i.test(p)) p += '.md';
  if (files.some((f) => f.path === p)) { alert('Cette note existe déjà.'); return; }
  if (dirty && !confirm('Modifications non enregistrées. Les abandonner ?')) return;
  const title = p.split('/').pop().replace(/\.(md|markdown)$/i, '');
  setStatus('Création…');
  try {
    const res = await gh('/contents/' + encPath(p), {
      method: 'PUT',
      body: JSON.stringify({ message: 'Création de ' + p, content: utf8ToB64('# ' + title + '\n'), branch }),
    });
    files.push({ path: p, sha: res.content.sha });
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) openDirs.add(parts.slice(0, i).join('/'));
    localStorage.setItem(LS_OPEN, JSON.stringify([...openDirs]));
    dirty = false;
    cur = null;
    await openFile(p);
    setStatus('Note créée (commit ' + res.commit.sha.slice(0, 7) + ')', 'ok');
  } catch (e) {
    setStatus('Échec : ' + e.message, 'err');
  }
}

// ---------- Rendu Markdown -> HTML ----------
// Supporté : titres (avec ancres), paragraphes, gras / italique / barré, code inline et blocs,
// liens (externes, ancres, vers d'autres notes), images https, listes imbriquées,
// cases à cocher interactives, citations, tableaux, séparateurs.
// Tout le texte est échappé avant génération du HTML (pas d'injection possible).
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function slug(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
}

// --- Inline ---
function fmt(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(.+?)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/\*([^*\n]+?)\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
}

function inline(raw) {
  const stash = [];
  const keep = (html) => { stash.push(html); return '\u0000' + (stash.length - 1) + '\u0000'; };

  // 1) code inline (protégé du reste)
  let s = raw.replace(/`([^`]+)`/g, (_, c) => keep('<code>' + esc(c) + '</code>'));
  // 2) échappement HTML
  s = esc(s).replace(/ {2,}\n/g, '<br>');

  // 3) images (https uniquement)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*?&quot;)?\)/g, (m, alt, url) =>
    /^https?:/i.test(url) ? keep('<img src="' + url + '" alt="' + alt + '" loading="lazy">') : alt);

  // 4) liens [texte](url "titre")
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;(.*?)&quot;)?\)/g, (m, txt, url, title) => {
    let attrs;
    if (/^(https?:|mailto:)/i.test(url)) attrs = 'href="' + url + '" target="_blank" rel="noopener noreferrer"';
    else if (url[0] === '#') attrs = 'href="' + url + '"';
    else if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return m;            // javascript:, data:, etc. refusés
    else attrs = 'href="#" data-note="' + url + '"';                 // lien relatif vers une autre note
    if (title) attrs += ' title="' + title + '"';
    return keep('<a ' + attrs + '>' + fmt(txt) + '</a>');
  });

  // 5) liens automatiques : <https://…> et URL nues
  s = s.replace(/&lt;(https?:\/\/[^\s]+?)&gt;/g, (m, url) =>
    keep('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>'));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, (m, pre, url) =>
    pre + keep('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>'));

  // 6) mise en forme
  s = fmt(s);

  // 7) restauration des éléments protégés (imbrications possibles)
  for (let k = 0; k < 4 && /\u0000\d+\u0000/.test(s); k++) {
    s = s.replace(/\u0000(\d+)\u0000/g, (_, j) => stash[+j]);
  }
  return s;
}

// --- Blocs ---
let slugSeen = {};
const RE_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RE_HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const RE_FENCE = /^\s{0,3}(\x60{3,}|~{3,})\s*([\w+-]*)/;
const RE_HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*$/;
const RE_QUOTE = /^\s{0,3}>/;
const isSep = (s) => s.includes('|') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s);
const cells = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '')
  .split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

// Construit une liste (éventuellement imbriquée) à partir d'items à plat
function buildList(items, pos, indent) {
  const tag = items[pos.i].ordered ? 'ol' : 'ul';
  let h = '<' + tag + '>';
  while (pos.i < items.length && items[pos.i].indent >= indent) {
    const it = items[pos.i++];
    h += '<li' + (it.task ? ' class="task' + (it.checked ? ' done' : '') + '"' : '') + '>';
    if (it.task) {
      // data-line = n° de ligne dans le texte source : sert à répercuter la case dans l'éditeur
      h += '<input type="checkbox" data-line="' + it.n + '"' + (it.checked ? ' checked' : '') + '> ';
    }
    h += inline(it.text);
    if (pos.i < items.length && items[pos.i].indent > it.indent) {
      h += buildList(items, pos, items[pos.i].indent);
    }
    h += '</li>';
  }
  return h + '</' + tag + '>';
}

// lines : [{ t: texte de la ligne, n: n° de ligne dans le source }]
function blocks(lines) {
  const out = [];
  let i = 0;

  // Une nouvelle structure commence-t-elle à la ligne idx ? (sert à couper les paragraphes)
  const startsBlock = (idx) => {
    const t = lines[idx].t;
    return RE_FENCE.test(t) || RE_HEAD.test(t) || RE_HR.test(t) || RE_QUOTE.test(t) || RE_ITEM.test(t) ||
      (t.includes('|') && idx + 1 < lines.length && isSep(lines[idx + 1].t));
  };

  while (i < lines.length) {
    const { t, n } = lines[i];
    let m;

    if (!t.trim()) { i++; continue; }

    // Bloc de code
    if ((m = t.match(RE_FENCE))) {
      const mark = m[1][0] === '~' ? '~' : '\\x60';
      const close = new RegExp('^\\s{0,3}[' + mark + ']{' + m[1].length + ',}\\s*$');
      const buf = [];
      i++;
      while (i < lines.length && !close.test(lines[i].t)) buf.push(lines[i++].t);
      i++;
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }

    // Titre
    if ((m = t.match(RE_HEAD))) {
      const text = m[2].replace(/\s+#+$/, '');
      const base = slug(text);
      slugSeen[base] = (slugSeen[base] || 0) + 1;
      const id = 'md-' + base + (slugSeen[base] > 1 ? '-' + (slugSeen[base] - 1) : '');
      out.push('<h' + m[1].length + ' id="' + id + '">' + inline(text) + '</h' + m[1].length + '>');
      i++;
      continue;
    }

    // Séparateur
    if (RE_HR.test(t)) { out.push('<hr>'); i++; continue; }

    // Citation (contenu rendu récursivement)
    if (RE_QUOTE.test(t)) {
      const inner = [];
      while (i < lines.length && RE_QUOTE.test(lines[i].t)) {
        inner.push({ t: lines[i].t.replace(/^\s{0,3}>\s?/, ''), n: lines[i].n });
        i++;
      }
      out.push('<blockquote>' + blocks(inner) + '</blockquote>');
      continue;
    }

    // Tableau
    if (t.includes('|') && i + 1 < lines.length && isSep(lines[i + 1].t)) {
      const head = cells(t);
      const aligns = cells(lines[i + 1].t).map((c) =>
        /^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : '');
      const al = (k) => (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '');
      let h = '<table><thead><tr>' + head.map((c, k) => '<th' + al(k) + '>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && lines[i].t.trim() && lines[i].t.includes('|')) {
        h += '<tr>' + cells(lines[i].t).map((c, k) => '<td' + al(k) + '>' + inline(c) + '</td>').join('') + '</tr>';
        i++;
      }
      out.push(h + '</tbody></table>');
      continue;
    }

    // Liste (puces, numérotée, cases à cocher)
    if (RE_ITEM.test(t)) {
      const items = [];
      while (i < lines.length) {
        const L = lines[i];
        const mm = L.t.match(RE_ITEM);
        if (mm && !RE_HR.test(L.t)) {
          const task = mm[3].match(/^\[( |x|X)\](?:\s+(.*))?$/);
          items.push({
            indent: mm[1].replace(/\t/g, '    ').length,
            ordered: /\d/.test(mm[2]),
            text: task ? (task[2] || '') : mm[3],
            task: !!task,
            checked: task ? task[1] !== ' ' : false,
            n: L.n,
          });
          i++;
        } else if (L.t.trim() && /^\s+\S/.test(L.t) && items.length && !RE_FENCE.test(L.t)) {
          items[items.length - 1].text += '\n' + L.t.trim();   // ligne de continuation
          i++;
        } else if (!L.t.trim() && i + 1 < lines.length && RE_ITEM.test(lines[i + 1].t)) {
          i++;                                                  // ligne vide au sein d'une liste
        } else break;
      }
      out.push(buildList(items, { i: 0 }, 0));
      continue;
    }

    // Paragraphe
    const buf = [t];
    i++;
    while (i < lines.length && lines[i].t.trim() && !startsBlock(i)) buf.push(lines[i++].t);
    out.push('<p>' + inline(buf.join('\n')) + '</p>');
  }
  return out.join('\n');
}

function md(src) {
  slugSeen = {};
  const lines = src.replace(/\u0000/g, '').split('\n').map((t, n) => ({ t: t.replace(/\r$/, ''), n }));
  return blocks(lines);
}

function renderPreview() {
  $('#preview').innerHTML = md($('#editor').value);
}

function togglePreview() {
  previewOn = !previewOn;
  $('#preview').hidden = !previewOn;
  $('#editor').hidden = previewOn;
  $('#btnPreview').textContent = previewOn ? 'Édition' : 'Aperçu';
  if (previewOn) renderPreview(); else $('#editor').focus();
}

// ---------- Interactions dans l'aperçu ----------
function scrollToAnchor(hash) {
  const el = document.getElementById('md-' + slug(hash));
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Ouvre une note ciblée par un lien relatif (ex : ../autre/note.md#titre)
async function openLinkedNote(rel) {
  let [p, hash] = rel.split('#');
  try { p = decodeURIComponent(p); } catch (_) {}
  const parts = p.startsWith('/') || !cur ? [] : cur.path.split('/').slice(0, -1);
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  const target = parts.join('/');
  const f = files.find((x) => x.path === target) || files.find((x) => x.path === target + '.md');
  if (!f) { setStatus('Note introuvable : ' + target, 'warn'); return; }
  await openFile(f.path);
  if (hash && cur && cur.path === f.path) scrollToAnchor(hash);
}

$('#preview').addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (a.dataset.note !== undefined) {
    e.preventDefault();
    openLinkedNote(a.dataset.note);
  } else if (href.startsWith('#')) {
    e.preventDefault();
    let h = href.slice(1);
    try { h = decodeURIComponent(h); } catch (_) {}
    scrollToAnchor(h);
  }
});

// Cocher / décocher une case dans l'aperçu : on modifie la ligne correspondante dans l'éditeur
$('#preview').addEventListener('change', (e) => {
  const box = e.target;
  if (!box.matches || !box.matches('input[type="checkbox"][data-line]')) return;
  const ed = $('#editor');
  const lines = ed.value.split('\n');
  const n = +box.dataset.line;
  const re = /^(\s*(?:>\s?)*\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]/;
  if (!cur || n >= lines.length || !re.test(lines[n])) {
    box.checked = !box.checked;   // annule : la ligne source est introuvable
    setStatus('Impossible de modifier cette case', 'warn');
    return;
  }
  lines[n] = lines[n].replace(re, '$1[' + (box.checked ? 'x' : ' ') + ']');
  ed.value = lines.join('\n');
  const li = box.closest('li');
  if (li) li.classList.toggle('done', box.checked);
  ed.dispatchEvent(new Event('input'));   // met à jour l'état « modifié » (●) et le bouton Enregistrer
});

// ---------- Paramètres ----------
function openSettings() {
  $('#setRepo').value = cfg.repo;
  $('#setBranch').value = cfg.branch;
  $('#setToken').value = cfg.token;
  $('#setMsg').value = cfg.msg;
  $('#dlgSettings').showModal();
}

// ---------- Événements ----------
$('#editor').addEventListener('input', () => {
  dirty = cur ? $('#editor').value !== cur.saved : false;
  updateUI();
});
$('#editor').addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    document.execCommand('insertText', false, '  ');
  }
});
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 's') {
    e.preventDefault();
    save();
  } else if (mod && !e.altKey && !e.shiftKey && k === 'e') {
    e.preventDefault();      // Ctrl+E : bascule édition Markdown <-> rendu HTML
    togglePreview();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});
$('#btnSave').addEventListener('click', save);
$('#btnNew').addEventListener('click', newNote);
$('#btnPreview').addEventListener('click', togglePreview);
$('#btnPreview').title = 'Basculer édition / aperçu (Ctrl+E)';
$('#btnSettings').addEventListener('click', openSettings);
$('#btnCancel').addEventListener('click', () => $('#dlgSettings').close());
$('#btnMenu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#filter').addEventListener('input', renderTree);
$('#btnRefresh').addEventListener('click', () => {
  if (dirty && !confirm('Modifications non enregistrées. Recharger quand même ?')) return;
  loadTree();
});
$('#formSettings').addEventListener('submit', (e) => {
  e.preventDefault();
  cfg = {
    repo: $('#setRepo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, ''),
    branch: $('#setBranch').value.trim(),
    token: $('#setToken').value.trim(),
    msg: $('#setMsg').value.trim() || 'Mise à jour de {path}',
  };
  localStorage.setItem(LS_CFG, JSON.stringify(cfg));
  $('#dlgSettings').close();
  cur = null; dirty = false;
  $('#editor').value = ''; $('#editor').disabled = true;
  updateUI();
  loadTree();
});

// ---------- Démarrage ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
updateUI();
loadTree();
