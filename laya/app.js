
// ============================================================================
// Workflow de nœuds + Laya (modèle ONNX exécuté dans la page via Transformers.js
// / ONNX Runtime Web en WebGPU). Aucune dépendance locale : tout est chargé
// depuis des CDN, les modèles depuis Hugging Face puis mis en cache IndexedDB.
// ============================================================================
'use strict';

/* ============================== Constantes ================================ */
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const STORAGE_KEY = 'workflow-laya-v1';
const IDB_NAME = 'laya-modeles';
const IDB_STORE = 'fichiers';
const NODE_W = 180;
const NODE_H = 64;
const MAX_STEPS = 200;
const SVGNS = 'http://www.w3.org/2000/svg';
const FENCE = '\u0060\u0060\u0060'; // trois accents graves (évite de les écrire en dur)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const $ = (s) => document.querySelector(s);

/* ============================== Utilitaires =============================== */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}
function safeJson(v, max = 1500) {
  try {
    const s = JSON.stringify(v, (k, x) => {
      if (typeof x === 'string' && x.length > max) return x.slice(0, max) + '… (+' + (x.length - max) + ' car.)';
      if (typeof File !== 'undefined' && x instanceof File) return '[Fichier ' + x.name + ']';
      return x;
    }, 2);
    return s === undefined ? String(v) : s;
  } catch (e) { return String(v); }
}
function showValue(v) { return typeof v === 'string' ? v : safeJson(v); }
const fmtMo = (b) => (b / 1048576).toFixed(0);
const fmtMs = (ms) => (ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s');

/* ============================ État du workflow ============================ */
let state = { nodes: [], edges: [] };
let selected = null; // { type: 'node' | 'edge', id }
let uid = 0;
const newId = (p) => p + Date.now().toString(36) + (uid++).toString(36);

function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignoré */ } }
function loadSaved() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) { const o = JSON.parse(s); if (Array.isArray(o.nodes) && Array.isArray(o.edges)) return o; }
  } catch (e) { /* ignoré */ }
  return null;
}

function exampleWorkflow() {
  const extraction = [
    '// input : le document déposé ({ name, text, pages, file })',
    '// Par défaut, Laya reçoit l\'entrée du nœud comme contexte.',
    'const data = await ctx.laya.ask(',
    '  "Extrais les informations de ce document (facture ou devis). Mets null si une information est absente. Les montants sont des nombres, sans devise.",',
    '  {',
    '    type: "json",',
    '    schema: {',
    '      type: "facture ou devis",',
    '      fournisseur: "",',
    '      numero: "",',
    '      date: "JJ/MM/AAAA",',
    '      total_ht: 0,',
    '      total_tva: 0,',
    '      total_ttc: 0',
    '    }',
    '  }',
    ');',
    'return data;'
  ].join('\n');

  const controle = [
    '// input : l\'objet JSON produit par le nœud précédent',
    'if (!input || typeof input !== "object") {',
    '  return ctx.goto("anomalie", { problemes: ["extraction illisible"] });',
    '}',
    'const num = (v) => typeof v === "number" ? v : parseFloat(String(v).split(" ").join("").replace(",", "."));',
    'const ht = num(input.total_ht), tva = num(input.total_tva), ttc = num(input.total_ttc);',
    'const problemes = [];',
    'if (![ht, tva, ttc].every(Number.isFinite)) problemes.push("montant manquant ou illisible");',
    'else if (Math.abs(ht + tva - ttc) > 0.02) problemes.push("HT + TVA différent de TTC");',
    'if (!input.numero) problemes.push("numéro absent");',
    'if (!input.fournisseur) problemes.push("fournisseur absent");',
    'if (problemes.length) return ctx.goto("anomalie", { ...input, problemes });',
    'return ctx.goto("ok", input);'
  ].join('\n');

  const conforme = [
    '// Branche « ok »',
    'return "Document conforme : " + input.type + " " + input.numero + " de " + input.fournisseur + " — " + input.total_ttc + " TTC";'
  ].join('\n');

  const anomalie = [
    '// Branche « anomalie »',
    'return { statut: "À vérifier", problemes: input.problemes, donnees: input };'
  ].join('\n');

  return {
    nodes: [
      { id: 'n_extraction', name: 'Extraction', x: 40, y: 70, code: extraction },
      { id: 'n_controle', name: 'Contrôle', x: 300, y: 70, code: controle },
      { id: 'n_conforme', name: 'Conforme', x: 580, y: 20, code: conforme },
      { id: 'n_anomalie', name: 'Anomalie', x: 580, y: 140, code: anomalie }
    ],
    edges: [
      { id: 'e1', from: 'n_extraction', to: 'n_controle', label: '' },
      { id: 'e2', from: 'n_controle', to: 'n_conforme', label: 'ok' },
      { id: 'e3', from: 'n_controle', to: 'n_anomalie', label: 'anomalie' }
    ]
  };
}

/* ============================ Éditeur visuel ============================== */
const world = $('#world');
const edgeLayer = $('#edgeLayer');
const nodeEls = new Map();

const outPoint = (n) => ({ x: n.x + NODE_W, y: n.y + NODE_H / 2 });
const inPoint = (n) => ({ x: n.x, y: n.y + NODE_H / 2 });
function curve(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return 'M ' + a.x + ' ' + a.y + ' C ' + (a.x + dx) + ' ' + a.y + ', ' + (b.x - dx) + ' ' + b.y + ', ' + b.x + ' ' + b.y;
}

function renderAll() {
  for (const el of nodeEls.values()) el.remove();
  nodeEls.clear();
  state.nodes.forEach(createNodeEl);
  updateSelectionClasses();
  drawEdges();
  renderInspector();
}

function createNodeEl(n) {
  const el = h('div', { class: 'node', 'data-id': n.id },
    h('div', { class: 'port in' }),
    h('div', { class: 'node-title' }, n.name || '(sans nom)'),
    h('div', { class: 'node-status' }),
    h('div', { class: 'port out' }));
  el.style.left = n.x + 'px';
  el.style.top = n.y + 'px';
  el.addEventListener('pointerdown', (e) => onNodePointerDown(e, n, el));
  world.append(el);
  nodeEls.set(n.id, el);
}

function updateSelectionClasses() {
  for (const [id, el] of nodeEls) {
    el.classList.toggle('selected', !!selected && selected.type === 'node' && selected.id === id);
  }
}

function select(type, id) {
  selected = type ? { type, id } : null;
  updateSelectionClasses();
  drawEdges();
  renderInspector();
}

function onNodePointerDown(e, n, el) {
  if (e.button !== 0) return;
  if (e.target.classList.contains('out')) { startLink(e, n); return; }
  if (e.target.classList.contains('in')) return;
  e.preventDefault();
  select('node', n.id);
  const sx = e.clientX, sy = e.clientY, ox = n.x, oy = n.y;
  let moved = false;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    n.x = Math.max(0, Math.round(ox + dx));
    n.y = Math.max(0, Math.round(oy + dy));
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    drawEdges();
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    if (moved) save();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function startLink(e, from) {
  e.preventDefault();
  const temp = svgEl('path', { class: 'edge temp' });
  edgeLayer.append(temp);
  const p1 = outPoint(from);
  const move = (ev) => {
    const r = world.getBoundingClientRect();
    temp.setAttribute('d', curve(p1, { x: ev.clientX - r.left, y: ev.clientY - r.top }));
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    temp.remove();
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    const nodeEl = target && target.closest ? target.closest('.node') : null;
    if (!nodeEl) return;
    const toId = nodeEl.dataset.id;
    if (toId === from.id) return;
    if (state.edges.some((x) => x.from === from.id && x.to === toId && !x.label)) return;
    const edge = { id: newId('e'), from: from.id, to: toId, label: '' };
    state.edges.push(edge);
    save();
    select('edge', edge.id);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function drawEdges() {
  edgeLayer.replaceChildren();
  for (const ed of state.edges) {
    const a = state.nodes.find((n) => n.id === ed.from);
    const b = state.nodes.find((n) => n.id === ed.to);
    if (!a || !b) continue;
    const p1 = outPoint(a), p2 = inPoint(b);
    const d = curve(p1, p2);
    const isSel = !!selected && selected.type === 'edge' && selected.id === ed.id;
    const g = svgEl('g', { class: 'edge-g' + (isSel ? ' selected' : '') });
    const hit = svgEl('path', { class: 'edge-hit', d });
    hit.addEventListener('pointerdown', (e) => { e.stopPropagation(); select('edge', ed.id); });
    g.append(svgEl('path', { class: 'edge', d }), hit);
    if (ed.label) {
      const t = svgEl('text', { class: 'edge-label', x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 - 6 });
      t.textContent = ed.label;
      g.append(t);
    }
    edgeLayer.append(g);
  }
}

world.addEventListener('pointerdown', (e) => { if (e.target === world) select(null); });

function deleteNode(id) {
  state.nodes = state.nodes.filter((n) => n.id !== id);
  state.edges = state.edges.filter((e) => e.from !== id && e.to !== id);
  const el = nodeEls.get(id);
  if (el) el.remove();
  nodeEls.delete(id);
  save();
  select(null);
}
function deleteEdge(id) {
  state.edges = state.edges.filter((e) => e.id !== id);
  save();
  select(null);
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' || !selected) return;
  if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (selected.type === 'node') deleteNode(selected.id); else deleteEdge(selected.id);
});

function apiHelp() {
  return h('details', {},
    h('summary', {}, 'Aide : API d\'un nœud'),
    h('pre', {}, [
      'Signature : async (input, ctx) => valeur',
      '',
      'input  : résultat du nœud précédent',
      '         (le document pour les nœuds de départ)',
      'ctx.doc : document déposé { name, size, pages[], text, file }',
      '',
      'ctx.laya.ask(question, options) -> Promise',
      '  options.type    : "text" (défaut) | "json" | "boolean" | "classification"',
      '  options.labels  : ["a","b"]  (classification)',
      '  options.schema  : exemple d\'objet attendu (json)',
      '  options.context : texte ou objet (défaut : input)',
      '  options.maxChars, options.maxTokens, options.system',
      '  Retour : texte | objet | true/false/null | libellé/null',
      '',
      'return valeur            -> suit les liens SANS étiquette',
      'return ctx.goto("x", v)  -> suit les liens étiquetés "x"',
      'return undefined         -> input transmis tel quel',
      '',
      'ctx.outputs : résultats déjà calculés, par nom de nœud',
      'ctx.log(...) : trace dans le journal du document',
      '',
      'Un nœud sans lien sortant correspondant donne un',
      'résultat final du document.'
    ].join('\n')));
}

function renderInspector() {
  const box = $('#inspector');
  box.replaceChildren();
  if (selected && selected.type === 'node') {
    const n = state.nodes.find((x) => x.id === selected.id);
    if (!n) return;
    const name = h('input', { type: 'text', value: n.name });
    name.addEventListener('input', () => {
      n.name = name.value;
      const t = nodeEls.get(n.id);
      if (t) t.querySelector('.node-title').textContent = n.name || '(sans nom)';
      save();
    });
    const code = h('textarea', { class: 'code', spellcheck: 'false' });
    code.value = n.code;
    code.addEventListener('input', () => { n.code = code.value; save(); });
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        code.setRangeText('  ', code.selectionStart, code.selectionEnd, 'end');
        n.code = code.value;
        save();
      }
    });
    box.append(
      h('h2', {}, 'Nœud'),
      h('label', {}, 'Nom', name),
      h('label', {}, 'Fonction JavaScript (corps d\'une fonction async)', code),
      h('button', { class: 'danger', onclick: () => deleteNode(n.id) }, 'Supprimer le nœud'),
      apiHelp());
  } else if (selected && selected.type === 'edge') {
    const ed = state.edges.find((x) => x.id === selected.id);
    if (!ed) return;
    const a = state.nodes.find((n) => n.id === ed.from), b = state.nodes.find((n) => n.id === ed.to);
    const label = h('input', { type: 'text', value: ed.label || '', placeholder: 'vide = sortie par défaut' });
    label.addEventListener('input', () => { ed.label = label.value.trim(); save(); drawEdges(); });
    box.append(
      h('h2', {}, 'Lien'),
      h('div', { class: 'muted' }, (a ? a.name : '?') + '  →  ' + (b ? b.name : '?')),
      h('label', {}, 'Étiquette (correspond à ctx.goto("étiquette", …))', label),
      h('button', { class: 'danger', onclick: () => deleteEdge(ed.id) }, 'Supprimer le lien'),
      apiHelp());
  } else {
    box.append(
      h('h2', {}, 'Inspecteur'),
      h('p', { class: 'muted' }, 'Sélectionne un nœud ou un lien pour le modifier. Les nœuds sans lien entrant reçoivent le document déposé.'),
      apiHelp());
  }
}

/* Statuts affichés sur les nœuds pendant l'exécution */
function setNodeStatus(id, st, text) {
  const el = nodeEls.get(id);
  if (!el) return;
  el.classList.remove('st-running', 'st-ok', 'st-error');
  if (st) el.classList.add('st-' + st);
  el.querySelector('.node-status').textContent = text || '';
}
function resetNodeStatuses() { state.nodes.forEach((n) => setNodeStatus(n.id, null, '')); }

/* Barre d'outils */
$('#btnAddNode').onclick = () => {
  const sc = $('#canvasScroll');
  const n = {
    id: newId('n'), name: 'Nœud ' + (state.nodes.length + 1),
    x: sc.scrollLeft + 40 + (state.nodes.length % 6) * 24,
    y: sc.scrollTop + 40 + (state.nodes.length % 6) * 24,
    code: '// input : résultat du nœud précédent\nreturn input;'
  };
  state.nodes.push(n);
  createNodeEl(n);
  save();
  select('node', n.id);
};
$('#btnExample').onclick = () => {
  if (state.nodes.length && !confirm('Remplacer le workflow actuel par l\'exemple ?')) return;
  state = exampleWorkflow();
  selected = null;
  save();
  renderAll();
};
$('#btnExport').onclick = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: 'workflow.json' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
$('#btnImport').onclick = () => $('#fileImport').click();
$('#fileImport').onchange = async (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  try {
    const o = JSON.parse(await f.text());
    if (!Array.isArray(o.nodes) || !Array.isArray(o.edges)) throw new Error('format invalide');
    const nodes = o.nodes.map((n) => ({
      id: String(n.id), name: String(n.name || 'Nœud'), x: Number(n.x) || 0, y: Number(n.y) || 0,
      code: String(n.code || 'return input;')
    }));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = o.edges
      .filter((e) => ids.has(String(e.from)) && ids.has(String(e.to)))
      .map((e) => ({ id: String(e.id || newId('e')), from: String(e.from), to: String(e.to), label: String(e.label || '') }));
    state = { nodes, edges };
    selected = null;
    save();
    renderAll();
  } catch (err) { alert('Import impossible : ' + err.message); }
};

/* =========================== Cache IndexedDB ============================== */
let idbPromise = null;
function idb() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return idbPromise;
}
async function idbTx(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, mode);
    const req = fn(tx.objectStore(IDB_STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
// Cache personnalisé pour Transformers.js : remplace le Cache API du navigateur.
const idbCache = {
  async match(request) {
    const key = typeof request === 'string' ? request : request.url;
    const rec = await idbTx('readonly', (s) => s.get(key));
    if (!rec) return undefined;
    return new Response(rec.blob, { status: 200, headers: rec.headers });
  },
  async put(request, response) {
    const key = typeof request === 'string' ? request : request.url;
    const headers = {};
    response.headers.forEach((v, k) => { if (k !== 'content-encoding') headers[k] = v; });
    const blob = await response.blob();
    await idbTx('readwrite', (s) => s.put({ blob, headers }, key));
  }
};
async function refreshStorage() {
  try {
    const est = await navigator.storage.estimate();
    $('#storageInfo').textContent = 'Stockage du site : ' + fmtMo(est.usage || 0) + ' Mo';
  } catch (e) { /* ignoré */ }
}

/* ========================= Laya : modèle en WebGPU ======================== */
const laya = { tjs: null, generator: null, loadedId: null, loading: null, loadingId: null, stop: null, queue: Promise.resolve(), gpu: null };
const runCtl = { cancel: false };

async function testWebGPU() {
  if (!('gpu' in navigator)) {
    return { ok: false, msg: 'WebGPU indisponible (navigator.gpu absent : navigateur trop ancien ou contexte non sécurisé)' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, msg: 'WebGPU présent mais aucun adaptateur GPU disponible' };
    const f16 = adapter.features.has('shader-f16');
    let desc = '';
    try {
      const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
      if (info) desc = [info.vendor, info.architecture].filter(Boolean).join(' ');
    } catch (e) { /* ignoré */ }
    return { ok: true, f16, msg: 'WebGPU disponible' + (desc ? ' (' + desc + ')' : '') + (f16 ? ' · f16' : ' · sans f16') };
  } catch (e) {
    return { ok: false, msg: 'Échec WebGPU : ' + e.message };
  }
}

async function ensureTjs() {
  if (laya.tjs) return laya.tjs;
  const tjs = await import(TRANSFORMERS_URL);
  tjs.env.allowLocalModels = false;
  const urlParams = new URLSearchParams(location.search);
  if (urlParams.get('cache') === 'browser') {
    tjs.env.useBrowserCache = true;      // cache natif du navigateur (test)
  } else {
    tjs.env.useBrowserCache = false;
    tjs.env.customCache = idbCache;      // cache IndexedDB
    tjs.env.useCustomCache = true;
  }
  laya.tjs = tjs;
  return tjs;
}

function setProgress(ratio, text, isError) {
  const bar = $('#progressBar');
  bar.classList.toggle('indet', ratio === null && !isError);
  bar.classList.toggle('err', !!isError);
  if (!isError && ratio !== null) bar.style.width = Math.round(ratio * 100) + '%';
  else if (!isError) bar.style.width = '';
  $('#progressText').textContent = text;
}
function setLive(text) {
  $('#live').textContent = text ? 'Laya : ' + text.slice(-180).replace(/\s+/g, ' ') : '';
}

async function loadModel() {
  const id = $('#modelId').value.trim();
  if (!id) throw new Error('Identifiant de modèle vide');
  if (laya.generator && laya.loadedId === id) return laya.generator;
  if (laya.loading && laya.loadingId === id) return laya.loading;

  laya.loadingId = id;
  laya.loading = (async () => {
    const gpu = laya.gpu || (laya.gpu = await testWebGPU());
    if (!gpu.ok) throw new Error(gpu.msg);
    const tjs = await ensureTjs();
    if (laya.generator && laya.generator.dispose) {
      try { await laya.generator.dispose(); } catch (e) { /* ignoré */ }
    }
    laya.generator = null;
    laya.loadedId = null;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignoré */ }

    setProgress(null, 'Chargement du modèle…');
    const files = new Map();
    const onProgress = (p) => {
      if (p.status === 'progress' && p.file) files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
      else if (p.status === 'done' && p.file) { const f = files.get(p.file); if (f) f.loaded = f.total; }
      let loaded = 0, total = 0;
      files.forEach((f) => { loaded += f.loaded; total += f.total; });
      if (total) setProgress(loaded / total, 'Téléchargement ' + fmtMo(loaded) + ' / ' + fmtMo(total) + ' Mo');
      else setProgress(null, 'Initialisation…');
    };
    const generator = await tjs.pipeline('text-generation', id, {
      device: 'webgpu',
      dtype: new URLSearchParams(location.search).get('dtype') || (gpu.f16 ? 'q4f16' : 'q4'),
      progress_callback: onProgress
    });
    laya.generator = generator;
    laya.loadedId = id;
    laya.stop = tjs.InterruptableStoppingCriteria ? new tjs.InterruptableStoppingCriteria() : null;
    setProgress(1, 'Modèle prêt : ' + id);
    refreshStorage();
    return generator;
  })();

  try {
    return await laya.loading;
  } catch (e) {
    setProgress(0, 'Erreur : ' + e.message, true);
    throw e;
  } finally {
    laya.loading = null;
  }
}

// Une seule génération à la fois (file d'attente)
function generate(messages, maxTokens) {
  const run = async () => {
    const generator = await loadModel();
    if (laya.stop) laya.stop.reset();
    let acc = '';
    const streamer = new laya.tjs.TextStreamer(generator.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (t) => { acc += t; setLive(acc); }
    });
    const opts = { max_new_tokens: maxTokens, do_sample: false, streamer };
    if (laya.stop) opts.stopping_criteria = laya.stop;
    const out = await generator(messages, opts);
    const gt = out[0].generated_text;
    const text = Array.isArray(gt) ? gt[gt.length - 1].content : String(gt);
    return String(text).trim();
  };
  const p = laya.queue.then(run);
  laya.queue = p.catch(() => {});
  return p;
}

function checkCancel() { if (runCtl.cancel) throw new Error('Exécution interrompue'); }

function formatContext(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (typeof c === 'object' && typeof c.text === 'string' && Array.isArray(c.pages)) return c.text;
  try { return JSON.stringify(c, (k, v) => (typeof File !== 'undefined' && v instanceof File ? undefined : v), 2); }
  catch (e) { return String(c); }
}

function extractJson(txt) {
  let s = txt.trim()
    .replace(new RegExp('^' + FENCE + '(?:json)?\\s*', 'i'), '')
    .replace(new RegExp(FENCE + '\\s*$'), '')
    .trim();
  try { return JSON.parse(s); } catch (e) { /* on essaie d'extraire */ }
  const i = s.search(/[\[{]/);
  if (i >= 0) {
    const close = s[i] === '{' ? '}' : ']';
    const j = s.lastIndexOf(close);
    if (j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { /* échec */ } }
  }
  return undefined;
}

// defaultContext : entrée du nœud ; onAsk : journalisation de chaque question
function makeLaya(defaultContext, onAsk) {
  return {
    async ask(question, opts = {}) {
      const type = opts.type || 'text';
      const maxChars = opts.maxChars || 12000;
      let context = formatContext(opts.context !== undefined ? opts.context : defaultContext);
      let truncated = false;
      if (context.length > maxChars) { context = context.slice(0, maxChars); truncated = true; }

      let format = '';
      let maxTokens = opts.maxTokens;
      if (type === 'json') {
        format = 'Réponds uniquement avec un objet JSON valide, sans commentaire ni balise markdown.' +
          (opts.schema ? ' Structure attendue : ' + JSON.stringify(opts.schema) : '');
        maxTokens = maxTokens || 700;
      } else if (type === 'boolean') {
        format = 'Réponds uniquement par OUI ou NON.';
        maxTokens = maxTokens || 8;
      } else if (type === 'classification') {
        if (!Array.isArray(opts.labels) || !opts.labels.length) throw new Error('ask : options.labels requis pour le type "classification"');
        format = 'Réponds uniquement par l\'un de ces libellés, recopié exactement : ' + opts.labels.join(' | ') + '.';
        maxTokens = maxTokens || 24;
      } else if (type === 'text') {
        maxTokens = maxTokens || 512;
      } else {
        throw new Error('ask : type inconnu "' + type + '"');
      }

      const system = opts.system ||
        'Tu es Laya, un assistant qui analyse des documents. Réponds en français. Appuie-toi uniquement sur le contexte fourni et n\'invente rien : si une information est absente, indique null ou "inconnu".';
      const user = (context ? 'Contexte :\n"""\n' + context + '\n"""\n\n' : '') + 'Question : ' + question + (format ? '\n\n' + format : '');
      const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];

      const t0 = performance.now();
      let raw = await generate(messages, maxTokens);
      checkCancel();
      let value;

      if (type === 'json') {
        value = extractJson(raw);
        if (value === undefined) { // une seule relance
          const retry = messages.concat([
            { role: 'assistant', content: raw },
            { role: 'user', content: 'Ta réponse n\'est pas un JSON valide. Réponds uniquement avec l\'objet JSON, rien d\'autre.' }
          ]);
          raw = await generate(retry, maxTokens);
          checkCancel();
          value = extractJson(raw);
        }
        if (value === undefined) {
          onAsk({ question, type, raw, ms: performance.now() - t0, truncated });
          throw new Error('Laya n\'a pas renvoyé de JSON valide');
        }
      } else if (type === 'boolean') {
        value = /^\s*(oui|yes|true|vrai)/i.test(raw) ? true : /^\s*(non|no|false|faux)/i.test(raw) ? false : null;
      } else if (type === 'classification') {
        const low = raw.toLowerCase();
        let best = null, bestIdx = Infinity;
        for (const l of opts.labels) {
          const i = low.indexOf(String(l).toLowerCase());
          if (i >= 0 && i < bestIdx) { best = l; bestIdx = i; }
        }
        value = best;
      } else {
        value = raw;
      }
      onAsk({ question, type, raw, ms: performance.now() - t0, truncated });
      return value;
    }
  };
}

/* =========================== Lecture des documents ======================== */
let pdfjs = null;
async function ensurePdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import(PDFJS_URL);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  return pdfjs;
}

async function readPdf(file) {
  const lib = await ensurePdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await lib.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const lines = [];
    let line = '', lastY = null, lastEnd = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const x = it.transform ? it.transform[4] : 0;
      const y = it.transform ? it.transform[5] : 0;
      if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line.trim()); line = ''; lastEnd = null; }
      if (line && lastEnd !== null) {
        const gap = x - lastEnd;
        if (gap > 6) line += '  '; else if (gap > 1) line += ' ';
      }
      line += it.str;
      lastEnd = x + (it.width || 0);
      lastY = y;
      if (it.hasEOL) { lines.push(line.trim()); line = ''; lastEnd = null; lastY = null; }
    }
    if (line.trim()) lines.push(line.trim());
    pages.push(lines.filter(Boolean).join('\n'));
  }
  try { await pdf.destroy(); } catch (e) { /* ignoré */ }
  return pages;
}

async function readDocument(file) {
  let pages;
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') pages = await readPdf(file);
  else if (/\.(txt|md|csv|json)$/i.test(file.name) || (file.type || '').startsWith('text/')) pages = [await file.text()];
  else throw new Error('Type de fichier non pris en charge (PDF ou texte uniquement)');
  const text = pages.map((p, i) => (pages.length > 1 ? '--- Page ' + (i + 1) + ' ---\n' + p : p)).join('\n\n');
  if (text.trim().length < 20) throw new Error('Aucun texte extractible (PDF scanné ? l\'OCR n\'est pas géré)');
  return { name: file.name, size: file.size, type: file.type, pages, text, file };
}

/* ============================ Moteur d'exécution ========================== */
class Branch { constructor(label, value) { this.label = label; this.value = value; } }

async function runWorkflow(run, docObj) {
  const nodes = state.nodes, edges = state.edges;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hasIncoming = new Set(edges.map((e) => e.to));
  let starts = nodes.filter((n) => !hasIncoming.has(n.id));
  if (!starts.length && nodes.length) starts = [nodes[0]];
  if (!starts.length) throw new Error('Le workflow est vide : ajoute au moins un nœud.');

  const outputs = {};
  const leaves = {};
  const queue = starts.map((n) => ({ node: n, input: docObj }));
  let count = 0;
  resetNodeStatuses();

  while (queue.length) {
    if (runCtl.cancel) throw new Error('Exécution interrompue');
    if (++count > MAX_STEPS) throw new Error('Plus de ' + MAX_STEPS + ' étapes : boucle probable dans le workflow');
    const { node, input } = queue.shift();
    const step = { nodeId: node.id, name: node.name, status: 'running', asks: [], logs: [], branch: '', ms: 0 };
    run.steps.push(step);
    setNodeStatus(node.id, 'running', 'en cours…');
    renderRun(run);
    const t0 = performance.now();

    try {
      const fn = new AsyncFunction('input', 'ctx', node.code);
      const ctx = {
        doc: docObj,
        outputs,
        goto: (label, value) => new Branch(label, value),
        log: (...a) => step.logs.push(a.map((x) => (typeof x === 'string' ? x : safeJson(x))).join(' ')),
        laya: makeLaya(input, (a) => { step.asks.push(a); renderRun(run); })
      };
      let ret = await fn(input, ctx);
      let label = '';
      if (ret instanceof Branch) { label = String(ret.label || '').trim(); ret = ret.value; }
      if (ret === undefined) ret = input;
      step.output = ret;
      step.branch = label;
      step.status = 'ok';
      outputs[node.name] = ret;
      const next = edges.filter((e) => e.from === node.id && String(e.label || '').trim() === label);
      if (!next.length) leaves[node.name] = ret;
      for (const e of next) { const target = byId.get(e.to); if (target) queue.push({ node: target, input: ret }); }
    } catch (err) {
      step.status = 'error';
      step.error = err && err.message ? err.message : String(err);
    }
    step.ms = performance.now() - t0;
    setNodeStatus(node.id, step.status, step.status === 'ok' ? fmtMs(step.ms) : 'erreur');
    renderRun(run);
  }
  return leaves;
}

/* ============================ Affichage résultats ========================= */
const ICONS = { running: '⏳', done: '✅', ok: '✅', error: '❌', cancelled: '⏹' };

function stepView(step) {
  const attrs = { class: 'step ' + step.status };
  if (step.status === 'error') attrs.open = '';
  return h('details', attrs,
    h('summary', {},
      ICONS[step.status] + ' ' + step.name,
      step.branch ? h('span', { class: 'tag' }, '→ ' + step.branch) : null,
      h('span', { class: 'muted' }, step.ms ? '  ' + fmtMs(step.ms) : '')),
    step.error ? h('div', { class: 'err' }, step.error) : null,
    step.status === 'ok' ? [h('div', { class: 'lbl' }, 'Sortie'), h('pre', {}, showValue(step.output))] : null,
    step.asks.map((a) => h('div', {},
      h('div', { class: 'lbl' }, 'Laya · ' + a.type + ' · ' + fmtMs(a.ms) + (a.truncated ? ' · contexte tronqué' : '')),
      h('div', {}, 'Q : ' + a.question),
      h('pre', {}, a.raw))),
    step.logs.length ? [h('div', { class: 'lbl' }, 'Journal'), h('pre', {}, step.logs.join('\n'))] : null);
}

function renderRun(run) {
  const resultBlock = [];
  if (run.result) {
    resultBlock.push(h('h3', {}, 'Résultat'));
    const keys = Object.keys(run.result);
    if (!keys.length) resultBlock.push(h('div', { class: 'muted' }, 'Aucun résultat final.'));
    for (const k of keys) resultBlock.push(h('div', {}, h('div', { class: 'lbl' }, k), h('pre', {}, showValue(run.result[k]))));
  }
  run.el.replaceChildren(
    h('summary', {},
      ICONS[run.status] + ' ' + run.name,
      h('span', { class: 'muted' }, run.ms ? '  ' + fmtMs(run.ms) : '')),
    run.error ? h('div', { class: 'err' }, run.error) : null,
    resultBlock,
    run.steps.length ? h('h3', {}, 'Étapes') : null,
    run.steps.map(stepView));
}

async function processFile(file) {
  const run = { name: file.name, status: 'running', steps: [], result: null, error: null, ms: 0, el: h('details', { class: 'run', open: '' }) };
  const t0 = performance.now();
  $('#results').prepend(run.el);
  renderRun(run);
  try {
    const docObj = await readDocument(file);
    run.result = await runWorkflow(run, docObj);
    run.status = run.steps.some((s) => s.status === 'error') ? 'error' : 'done';
  } catch (err) {
    run.status = runCtl.cancel ? 'cancelled' : 'error';
    run.error = err && err.message ? err.message : String(err);
  }
  run.ms = performance.now() - t0;
  renderRun(run);
}

/* ============================ Dépôt de fichiers =========================== */
let fileQueue = Promise.resolve();
let pending = 0;

function setRunning(on) {
  $('#btnStop').disabled = !on;
  if (!on) setLive('');
}
function enqueueFiles(files) {
  for (const f of files) {
    pending++;
    setRunning(true);
    fileQueue = fileQueue.then(async () => {
      try { if (!runCtl.cancel) await processFile(f); }
      finally {
        pending--;
        if (pending === 0) { runCtl.cancel = false; setRunning(false); }
      }
    });
  }
}

const drop = $('#drop');
drop.addEventListener('click', () => $('#fileInput').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') $('#fileInput').click(); });
$('#fileInput').addEventListener('change', (e) => { enqueueFiles([...e.target.files]); e.target.value = ''; });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  enqueueFiles([...e.dataTransfer.files]);
});
// Évite que le navigateur ouvre le fichier s'il est lâché à côté de la zone
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('#btnStop').onclick = () => {
  runCtl.cancel = true;
  if (laya.stop) laya.stop.interrupt();
};
$('#btnLoad').onclick = () => { loadModel().catch(() => {}); };
$('#btnClearCache').onclick = async () => {
  if (!confirm('Supprimer les modèles stockés dans l\'IndexedDB ?')) return;
  try { await idbTx('readwrite', (s) => s.clear()); } catch (e) { alert('Échec : ' + e.message); }
  refreshStorage();
};

/* ============================== Démarrage ================================= */
(async function init() {
  state = loadSaved() || exampleWorkflow();
  renderAll();
  const g = await testWebGPU();
  laya.gpu = g;
  const badge = $('#gpuBadge');
  badge.textContent = g.msg;
  badge.className = 'badge ' + (g.ok ? 'ok' : 'ko');
  if (!g.ok) {
    $('#btnLoad').disabled = true;
    setProgress(0, 'WebGPU requis pour charger le modèle', true);
  }
  refreshStorage();
})();