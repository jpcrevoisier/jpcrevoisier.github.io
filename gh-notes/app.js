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

// ---------- Aperçu Markdown minimal (échappement HTML systématique) ----------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(t) {
  return t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) =>
      /^(https?:|\.|\/|#)/.test(url) ? '<a href="' + url + '" target="_blank" rel="noopener">' + txt + '</a>' : m);
}

function md(src) {
  const blocks = [];
  const fence = new RegExp('\\x60{3}[^\\n]*\\n([\\s\\S]*?)\\x60{3}', 'g');
  const s = esc(src).replace(fence, (_, c) => { blocks.push(c); return '\u0000' + (blocks.length - 1) + '\u0000'; });
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  for (const line of s.split('\n')) {
    let m;
    if ((m = line.match(/^\u0000(\d+)\u0000$/))) {
      flushPara(); closeList();
      out.push('<pre><code>' + blocks[+m[1]] + '</code></pre>');
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara(); closeList();
      out.push('<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>');
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara(); closeList(); out.push('<hr>');
    } else if ((m = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/))) {
      flushPara();
      const type = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (list !== type) { closeList(); list = type; out.push('<' + type + '>'); }
      out.push('<li>' + inline(m[2]) + '</li>');
    } else if ((m = line.match(/^&gt;\s?(.*)$/))) {
      flushPara(); closeList();
      out.push('<blockquote>' + inline(m[1]) + '</blockquote>');
    } else if (!line.trim()) {
      flushPara(); closeList();
    } else {
      closeList(); para.push(line.trim());
    }
  }
  flushPara(); closeList();
  return out.join('\n');
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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});
$('#btnSave').addEventListener('click', save);
$('#btnNew').addEventListener('click', newNote);
$('#btnPreview').addEventListener('click', togglePreview);
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

