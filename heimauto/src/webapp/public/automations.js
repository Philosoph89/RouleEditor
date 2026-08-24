// URL helper: prefix absolute paths with the ingress base path (see app.js).
const U = (u) => (window.HEIMAUTO_URL ? window.HEIMAUTO_URL(u) : u);
// Automationen — graphical WENN/DANN rule editor.
//
// Model (verified byte-exact against RouleBase.hrb): each index run is one CHAIN
//   Auslöser (event-key)  ->  WENN <Bedingungen>  DANN <Aktionen>
// Many chains share one Auslöser. A statement is one parser line
// "Ziel <op> Quelle"; the server compiles it byte-exact. Every statement keeps
// its authoritative `line` string, so untouched rules round-trip unchanged.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const api = async (url, opts) => {
  const r = await fetch(U(url), opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r;
};
const J = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const hx2 = (n) => (n & 0xff).toString(16).toUpperCase().padStart(2, '0');
const hx1 = (n) => (n & 0xf).toString(16).toUpperCase();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let MODEL = { runs: [] };      // ordered master list of chains
let LABELS = {};
let selectedGid = null;
let dirty = false;

// ---- label resolution -----------------------------------------------------
function labelFor(token) {
  if (!token) return '';
  if (LABELS[token]) return LABELS[token];                 // exact bit/byte
  const byte = token.split('.').slice(0, 2).join('.');     // fall back to MM.S
  if (LABELS[byte]) return LABELS[byte];
  const mod = token.split('.')[0];                          // fall back to MM
  if (LABELS[mod]) return LABELS[mod];
  return '';
}
function triggerName(gid) {
  const t = decodeTrigger(gid);
  return LABELS['trigger:' + gid] || labelFor(t.token) || labelFor(`${hx2(t.module)}.${hx1(t.sub)}`) || labelFor(hx2(t.module)) || '';
}
function decodeTrigger(gid) {
  const module = (gid >> 7) & 0xff, ev = gid & 0x7f, sub = (ev >> 3) & 0x0f, bit = ev & 7;
  return { gid, module, sub, bit, token: `${hx2(module)}.${hx1(sub)}.${bit}` };
}

// ---- statement parsing / friendly operators -------------------------------
const OPS_LONG = [':=0', ':=1', '==0', '==1', '!=', '==', '=<', '>=', ':=', '~=', '&=', '|=', '^=', '+=', '-=', '>', '<'];

function splitStatement(line) {
  const t = String(line).replace(/\s+/g, '').replace(/;+$/, '');
  let at = -1, sym = '';
  for (const o of OPS_LONG) {
    const i = t.indexOf(o);
    if (i > 0 && (at < 0 || i < at || (i === at && o.length > sym.length))) { at = i; sym = o; }
  }
  if (at < 0) return { target: t, sym: '', src: '', raw: true };
  return { target: t.slice(0, at), sym, src: t.slice(at + sym.length) };
}

// target kind from its textual form
function targetKind(target) {
  const u = target.toUpperCase();
  if (/^(LST|LLT|ST|LT)\d*$/.test(u)) return 'timer';
  if (/^(DT|DATE|TIME|DATETIME)$/.test(u)) return 'time';
  const parts = target.split('.');
  if (parts.length === 3) return 'bit';
  if (parts.length === 2) return 'byte';
  return 'other';
}

// Friendly operator menus per target kind. Each option maps to a builder that
// turns (target, value) into a parser line and knows its role.
const MENUS = {
  bit: [
    { v: 'on?',   t: 'ist EIN',            role: 'condition', build: (tg) => `${tg}==Bit-Konstante(1)`, val: false },
    { v: 'off?',  t: 'ist AUS',            role: 'condition', build: (tg) => `${tg}==Bit-Konstante(0)`, val: false },
    { v: 'eqbit', t: 'gleich Bit …',       role: 'condition', build: (tg, s) => `${tg}==${s}`,          val: true, ph: 'z.B. 1C.3.1' },
    { v: 'nebit', t: 'ungleich Bit …',     role: 'condition', build: (tg, s) => `${tg}!=${s}`,          val: true, ph: 'z.B. 1C.3.1' },
    { v: 'seton', t: 'einschalten',        role: 'action',    build: (tg) => `${tg}:=Bit-Konstante(1)`, val: false },
    { v: 'setoff',t: 'ausschalten',        role: 'action',    build: (tg) => `${tg}:=Bit-Konstante(0)`, val: false },
    { v: 'toggle',t: 'umschalten',         role: 'action',    build: (tg) => `${tg}~=${tg}`,            val: false },
    { v: 'copy',  t: '= (Wert übernehmen)',role: 'action',    build: (tg, s) => `${tg}:=${s}`,          val: true, ph: 'z.B. 41.0.5' },
  ],
  byte: [
    { v: 'eq',  t: 'gleich (==)',      role: 'condition', build: (tg, s) => `${tg}==${s}`, val: true, ph: 'Wert $00–$FF oder MM.S' },
    { v: 'ne',  t: 'ungleich (≠)',     role: 'condition', build: (tg, s) => `${tg}!=${s}`, val: true, ph: 'Wert oder MM.S' },
    { v: 'gt',  t: 'größer (>)',       role: 'condition', build: (tg, s) => `${tg}>${s}`,  val: true, ph: 'Wert oder MM.S' },
    { v: 'lt',  t: 'kleiner (<)',      role: 'condition', build: (tg, s) => `${tg}<${s}`,  val: true, ph: 'Wert oder MM.S' },
    { v: 'ge',  t: 'größer/gleich (≥)',role: 'condition', build: (tg, s) => `${tg}>=${s}`, val: true, ph: 'Wert oder MM.S' },
    { v: 'le',  t: 'kleiner/gleich (≤)',role:'condition', build: (tg, s) => `${tg}=<${s}`, val: true, ph: 'Wert oder MM.S' },
    { v: 'set', t: 'setze auf Wert',   role: 'action',    build: (tg, s) => `${tg}:=${s}`, val: true, ph: 'Wert $00–$FF oder MM.S' },
    { v: 'add', t: 'addiere (+=)',     role: 'action',    build: (tg, s) => `${tg}+=${s}`, val: true, ph: 'Wert' },
    { v: 'sub', t: 'subtrahiere (−=)', role: 'action',    build: (tg, s) => `${tg}-=${s}`, val: true, ph: 'Wert' },
    { v: 'and', t: 'UND-Maske (&=)',   role: 'action',    build: (tg, s) => `${tg}&=${s}`, val: true, ph: 'Maske' },
    { v: 'or',  t: 'ODER-Maske (|=)',  role: 'action',    build: (tg, s) => `${tg}|=${s}`, val: true, ph: 'Maske' },
    { v: 'xor', t: 'XOR-Maske (^=)',   role: 'action',    build: (tg, s) => `${tg}^=${s}`, val: true, ph: 'Maske' },
  ],
  timer: [
    { v: 'set', t: 'starten / setzen', role: 'action',    build: (tg, s) => `${tg}:=${s}`, val: true, ph: 'ST/LST: Sek. · LT/LLT: Min.' },
    { v: 'eq',  t: 'gleich (==)',      role: 'condition', build: (tg, s) => `${tg}==${s}`, val: true, ph: 'Zeitwert' },
    { v: 'gt',  t: 'größer (>)',       role: 'condition', build: (tg, s) => `${tg}>${s}`,  val: true, ph: 'Zeitwert' },
    { v: 'lt',  t: 'kleiner (<)',      role: 'condition', build: (tg, s) => `${tg}<${s}`,  val: true, ph: 'Zeitwert' },
  ],
  time: [
    { v: 'eq', t: 'zum Zeitpunkt (==)', role: 'condition', build: (tg, s) => `${tg}==${s}`, val: true, ph: 'WT, TT.MM SS:MM (mit *)' },
  ],
};

// map a parsed (sym, src) back to a menu value for a given kind
function menuValueFor(kind, sym, src) {
  const s = (src || '').toLowerCase();
  if (kind === 'bit') {
    if (sym === '==' && /bit-konstante\(1\)/.test(s)) return { v: 'on?' };
    if (sym === '==' && /bit-konstante\(0\)/.test(s)) return { v: 'off?' };
    if (sym === ':=' && /bit-konstante\(1\)/.test(s)) return { v: 'seton' };
    if (sym === ':=' && /bit-konstante\(0\)/.test(s)) return { v: 'setoff' };
    if (sym === '~=') return { v: 'toggle' };
    if (sym === '==') return { v: 'eqbit', src };
    if (sym === '!=') return { v: 'nebit', src };
    if (sym === ':=') return { v: 'copy', src };
  }
  const map = { '==': 'eq', '!=': 'ne', '>': 'gt', '<': 'lt', '>=': 'ge', '=<': 'le', ':=': kind === 'timer' ? 'set' : 'set', '+=': 'add', '-=': 'sub', '&=': 'and', '|=': 'or', '^=': 'xor' };
  return { v: map[sym] || null, src };
}

// natural-language preview for one statement line
function humanize(line) {
  const { target, sym, src } = splitStatement(line);
  const nm = labelFor(target) || target;
  const srcNm = labelFor(src) || src;
  const kind = targetKind(target);
  if (kind === 'bit') {
    if (sym === '==' && /Bit-Konstante\(1\)/i.test(src)) return `wenn „${nm}" EIN ist`;
    if (sym === '==' && /Bit-Konstante\(0\)/i.test(src)) return `wenn „${nm}" AUS ist`;
    if (sym === ':=' && /Bit-Konstante\(1\)/i.test(src)) return `schalte „${nm}" EIN`;
    if (sym === ':=' && /Bit-Konstante\(0\)/i.test(src)) return `schalte „${nm}" AUS`;
    if (sym === '~=') return `schalte „${nm}" um`;
    if (sym === ':=') return `setze „${nm}" = „${srcNm}"`;
    if (sym === '==') return `wenn „${nm}" = „${srcNm}"`;
    if (sym === '!=') return `wenn „${nm}" ≠ „${srcNm}"`;
  }
  const opWord = { '==': 'gleich', '!=': 'ungleich', '>': 'größer als', '<': 'kleiner als', '>=': '≥', '=<': '≤', ':=': 'setze auf', '+=': 'plus', '-=': 'minus', '&=': 'UND', '|=': 'ODER', '^=': 'XOR' }[sym] || sym;
  const isAction = [':=', '+=', '-=', '&=', '|=', '^=', '~='].includes(sym);
  if (isAction) return `${opWord === 'setze auf' ? 'setze' : opWord} „${nm}"${srcNm ? ' ' + (opWord === 'setze auf' ? 'auf ' : '') + srcNm : ''}`;
  return `wenn „${nm}" ${opWord} ${srcNm}`;
}

function roleOfLine(line) {
  const { sym } = splitStatement(line);
  return [':=', '~=', '&=', '|=', '^=', '+=', '-=', ':=0', ':=1'].includes(sym) ? 'action' : 'condition';
}

// ---- data load ------------------------------------------------------------
async function loadModel() {
  const m = await api('/api/model');
  MODEL = { runs: m.runs.map((r) => ({ groupId: r.groupId, statements: r.statements.map((s) => ({ line: s.source })) })) };
  LABELS = m.labels || {};
  dirty = false; updateDirty();
  renderTriggerList();
  if (selectedGid == null && MODEL.runs.length) selectedGid = MODEL.runs[0].groupId;
  renderDetail();
}

function groupsByTrigger() {
  const map = new Map();
  MODEL.runs.forEach((run, idx) => {
    if (!map.has(run.groupId)) map.set(run.groupId, []);
    map.get(run.groupId).push({ run, idx });
  });
  return map;
}

// ---- render: trigger list -------------------------------------------------
function renderTriggerList() {
  const q = ($('#autoSearch').value || '').toLowerCase().trim();
  const groups = groupsByTrigger();
  const rows = [];
  for (const [gid, chains] of groups) {
    const t = decodeTrigger(gid);
    const name = triggerName(gid);
    const hay = `${name} ${t.token} ${gid.toString(16)} modul ${t.module}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    rows.push({ gid, t, name, n: chains.length });
  }
  rows.sort((a, b) => (a.name || 'zzz').localeCompare(b.name || 'zzz') || a.gid - b.gid);
  const el = $('#autoTriggerList');
  el.innerHTML = rows.map((r) => `
    <button class="trig ${r.gid === selectedGid ? 'sel' : ''}" data-gid="${r.gid}">
      <span class="trig-name">${esc(r.name || '(ohne Namen)')}</span>
      <span class="trig-meta">${r.t.token} · ${r.n} Regel${r.n === 1 ? '' : 'n'}</span>
    </button>`).join('') || '<p class="muted small">Keine Treffer.</p>';
  $$('.trig', el).forEach((b) => b.onclick = () => { selectedGid = Number(b.dataset.gid); renderTriggerList(); renderDetail(); });
}

// ---- render: detail (chains of the selected trigger) ----------------------
function renderDetail() {
  const host = $('#autoDetail');
  if (selectedGid == null) { host.innerHTML = '<p class="muted">Links einen Auslöser wählen.</p>'; return; }
  const t = decodeTrigger(selectedGid);
  const chains = groupsByTrigger().get(selectedGid) || [];
  const name = triggerName(selectedGid);
  host.innerHTML = `
    <div class="trig-head">
      <div>
        <div class="trig-title">Auslöser <code>${t.token}</code> <span class="muted">(Modul 0x${hx2(t.module)}, Sub ${hx1(t.sub)}, Bit ${t.bit})</span></div>
        <div class="muted small">Diese Regeln laufen, wenn sich dieser Eingang ändert.</div>
      </div>
      <label class="trig-namefield">Name
        <input id="trigName" value="${esc(name)}" placeholder="z.B. HWR Taster" />
      </label>
    </div>
    <div id="chainList"></div>
    <button id="btnAddChain" class="secondary">＋ Regel (WENN/DANN) hinzufügen</button>
  `;
  $('#trigName').onchange = (e) => {
    const v = e.target.value.trim();
    if (v) LABELS['trigger:' + selectedGid] = v; else delete LABELS['trigger:' + selectedGid];
    persistLabels(); renderTriggerList();
  };
  const cl = $('#chainList');
  cl.innerHTML = '';
  chains.forEach((c, ci) => cl.appendChild(renderChain(c.run, ci)));
  $('#btnAddChain').onclick = () => {
    const run = { groupId: selectedGid, statements: [] };
    // insert right after the last chain of this trigger to keep grouping
    const groups = groupsByTrigger().get(selectedGid);
    const insertAt = groups && groups.length ? groups[groups.length - 1].idx + 1 : MODEL.runs.length;
    MODEL.runs.splice(insertAt, 0, run);
    markDirty(); renderTriggerList(); renderDetail();
  };
}

function renderChain(run, ci) {
  const card = document.createElement('div');
  card.className = 'chain-card';
  card.innerHTML = `
    <div class="chain-head">
      <span class="chain-title">Regel ${ci + 1}</span>
      <span class="grow"></span>
      <button class="link dup">duplizieren</button>
      <button class="link danger del">löschen</button>
    </div>
    <div class="chain-section wenn"><div class="sec-label">WENN <span class="muted small">(alle Bedingungen erfüllt)</span></div><div class="rows conds"></div><button class="link add-cond">＋ Bedingung</button></div>
    <div class="chain-section dann"><div class="sec-label">DANN <span class="muted small">(Aktionen nacheinander)</span></div><div class="rows acts"></div><button class="link add-act">＋ Aktion</button></div>
  `;
  const conds = $('.conds', card), acts = $('.acts', card);
  const rerowAll = () => {
    conds.innerHTML = ''; acts.innerHTML = '';
    run.statements.forEach((st, si) => {
      const role = roleOfLine(st.line);
      (role === 'action' ? acts : conds).appendChild(renderRow(run, st, si));
    });
  };
  rerowAll();
  card._rerow = rerowAll;
  $('.add-cond', card).onclick = () => { run.statements.push({ line: '1C.0.0==Bit-Konstante(1)' }); markDirty(); renderDetail(); };
  $('.add-act', card).onclick = () => { run.statements.push({ line: '1A.0.0~=1A.0.0' }); markDirty(); renderDetail(); };
  $('.del', card).onclick = () => {
    const i = MODEL.runs.indexOf(run);
    if (i >= 0) MODEL.runs.splice(i, 1); markDirty(); renderTriggerList(); renderDetail();
  };
  $('.dup', card).onclick = () => {
    const i = MODEL.runs.indexOf(run);
    MODEL.runs.splice(i + 1, 0, { groupId: run.groupId, statements: run.statements.map((s) => ({ line: s.line })) });
    markDirty(); renderTriggerList(); renderDetail();
  };
  return card;
}

function renderRow(run, st, si) {
  const row = document.createElement('div');
  row.className = 'stmt-row';
  const parsed = splitStatement(st.line);
  const kind = targetKind(parsed.target);
  const menu = MENUS[kind] || null;
  const chosen = menu ? menuValueFor(kind, parsed.sym, parsed.src) : { v: null };

  if (!menu || parsed.raw) {
    // fallback: raw parser line (nothing is ever uneditable)
    row.innerHTML = `
      <input class="raw grow mono" value="${esc(st.line)}" />
      <span class="stmt-hex muted small"></span>
      <button class="link danger x">✕</button>`;
    const raw = $('.raw', row);
    raw.oninput = () => { st.line = raw.value; markDirty(); validateRow(row, st); };
  } else {
    const opts = menu.map((o) => `<option value="${o.v}" ${chosen.v === o.v ? 'selected' : ''}>${o.t}</option>`).join('');
    const needVal = menu.find((o) => o.v === chosen.v)?.val;
    row.innerHTML = `
      <input class="tgt mono" list="labelList" value="${esc(parsed.target)}" placeholder="Modul.Sub[.Bit]" />
      <span class="tgt-name pill"></span>
      <select class="op">${opts}</select>
      <input class="val mono" value="${esc(needVal ? valuePart(parsed, kind) : '')}" ${needVal ? '' : 'style="display:none"'} />
      <span class="stmt-hex muted small"></span>
      <button class="link danger x">✕</button>`;
    const tgt = $('.tgt', row), op = $('.op', row), val = $('.val', row);
    const rebuild = () => {
      const def = menu.find((o) => o.v === op.value) || menu[0];
      val.style.display = def.val ? '' : 'none';
      if (def.val && def.ph) val.placeholder = def.ph;
      st.line = def.build(tgt.value.trim(), val.value.trim());
      markDirty(); refreshRowMeta(row, st, tgt.value.trim());
    };
    tgt.oninput = rebuild; op.onchange = rebuild; val.oninput = rebuild;
    refreshRowMeta(row, st, parsed.target);
  }
  $('.x', row).onclick = () => { const i = run.statements.indexOf(st); if (i >= 0) run.statements.splice(i, 1); markDirty(); renderDetail(); };
  validateRow(row, st);
  return row;
}

function valuePart(parsed, kind) {
  // what to show in the value box for editable operators
  if (kind === 'bit') { if (/Bit-Konstante/i.test(parsed.src)) return ''; return parsed.src; }
  return parsed.src;
}

function refreshRowMeta(row, st, target) {
  const pill = $('.tgt-name', row);
  if (pill) { const nm = labelFor(target); pill.textContent = nm || ''; pill.style.display = nm ? '' : 'none'; }
  validateRow(row, st);
}

let checkTimer = null;
function validateRow(row, st) {
  const hex = $('.stmt-hex', row);
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    try {
      const r = await api('/api/model/checkline', J({ line: st.line }));
      if (r.ok && !r.empty) { row.classList.remove('bad'); hex.textContent = `${humanize(st.line)}  ·  ${r.hex}`; hex.title = st.line; }
      else if (r.empty) { row.classList.remove('bad'); hex.textContent = '(leer)'; }
      else { row.classList.add('bad'); hex.textContent = '⚠ ' + r.error; }
    } catch (e) { row.classList.add('bad'); hex.textContent = '⚠ ' + e.message; }
  }, 120);
}

// ---- labels / dirty / save ------------------------------------------------
async function persistLabels() { try { await api('/api/labels', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ labels: LABELS }) }); } catch { /* ignore */ } }
function markDirty() { dirty = true; updateDirty(); }
function updateDirty() { const el = $('#autoDirty'); if (el) el.textContent = dirty ? '● ungespeicherte Änderungen' : ''; el.className = 'muted small' + (dirty ? ' dirty' : ''); }

async function saveModel() {
  const payload = { save: true, model: { runs: MODEL.runs.map((r) => ({ groupId: r.groupId, lines: r.statements.map((s) => s.line) })) } };
  try {
    const r = await api('/api/model', J(payload));
    dirty = false; updateDirty();
    $('#autoDirty').textContent = `✓ gespeichert (${r.counts.runs} Auslöser-Regeln, ${r.counts.words} Befehle)`;
    setTimeout(() => updateDirty(), 2500);
  } catch (e) {
    // server returns {errors:[...]} on compile failure
    const msg = e.message || 'Fehler';
    alert('Speichern fehlgeschlagen:\n' + msg + '\n\nBitte die rot markierten Zeilen korrigieren.');
  }
}

// ---- generic modal --------------------------------------------------------
function modal(title, bodyEl, { okText = 'OK', onOk = null, wide = false } = {}) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-head"><span>${esc(title)}</span><button class="link close">✕</button></div>
      <div class="modal-body"></div>
      <div class="modal-foot">
        <button class="secondary cancel">Abbrechen</button>
        <button class="ok">${esc(okText)}</button>
      </div>
    </div>`;
  $('.modal-body', ov).appendChild(bodyEl);
  document.body.appendChild(ov);
  const close = () => ov.remove();
  $('.close', ov).onclick = close;
  $('.cancel', ov).onclick = close;
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  $('.ok', ov).onclick = async () => { if (!onOk || (await onOk()) !== false) close(); };
  return { close, root: ov };
}

// ---- new automation dialog (pick trigger by device or address) ------------
function newAutomation() {
  const bit3 = (k) => /^[0-9A-Fa-f]{2}\.[0-9A-Fa-f]\.[0-7]$/.test(k);
  const devices = Object.keys(LABELS).filter(bit3).sort((a, b) => (LABELS[a]).localeCompare(LABELS[b]));
  const body = document.createElement('div');
  body.className = 'form-grid';
  body.innerHTML = `
    <p class="muted small">Wähle den Eingang/Taster, dessen Änderung die Automation auslösen soll.</p>
    <label>Bekanntes Gerät
      <select id="naDev">
        <option value="">– manuell eingeben –</option>
        ${devices.map((k) => `<option value="${k}">${esc(LABELS[k])} (${k})</option>`).join('')}
      </select>
    </label>
    <div class="row">
      <label>Modul (Hex)<input id="naMod" value="1A" style="width:80px" /></label>
      <label>Sub (0–F)<input id="naSub" value="0" style="width:70px" /></label>
      <label>Bit (0–7)<input id="naBit" value="6" style="width:70px" /></label>
    </div>
    <div id="naPreview" class="na-preview"></div>`;
  const dev = $('#naDev', body), mod = $('#naMod', body), sub = $('#naSub', body), bit = $('#naBit', body), prev = $('#naPreview', body);
  const parse = () => {
    const m = parseInt(mod.value, 16), s = parseInt(sub.value, 16), b = parseInt(bit.value, 10);
    if ([m, s, b].some((x) => Number.isNaN(x)) || s > 15 || b > 7) return null;
    return { m, s, b, gid: (((m & 0xff) << 7) | ((((s & 0xf) * 8) + (b & 7)) & 0x7f)) & 0xffff };
  };
  const refresh = () => {
    const p = parse();
    if (!p) { prev.innerHTML = '<span class="bad-text">Ungültige Adresse.</span>'; return; }
    const tok = `${hx2(p.m)}.${hx1(p.s)}.${p.b}`;
    const exists = groupsByTrigger().has(p.gid);
    const nm = triggerName(p.gid);
    prev.innerHTML = `Auslöser <code>${tok}</code> ${nm ? '– „' + esc(nm) + '"' : ''}
      ${exists ? '<span class="warn-text">· existiert bereits – neue Regel wird ergänzt</span>' : '<span class="ok-text">· neuer Auslöser</span>'}`;
  };
  dev.onchange = () => { if (dev.value) { const [m, s, b] = dev.value.split('.'); mod.value = m; sub.value = s; bit.value = b; } refresh(); };
  [mod, sub, bit].forEach((el) => el.oninput = refresh);
  refresh();
  modal('Neue Automation', body, {
    okText: 'Anlegen', onOk: () => {
      const p = parse();
      if (!p) { alert('Bitte gültige Adresse eingeben.'); return false; }
      if (!groupsByTrigger().has(p.gid)) MODEL.runs.push({ groupId: p.gid, statements: [] });
      selectedGid = p.gid; markDirty(); renderTriggerList(); renderDetail();
    },
  });
}

// ---- labels manager -------------------------------------------------------
function openLabels() {
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="muted small">Klartext-Namen für Adressen und Auslöser. Adresse als <code>MM.S.B</code> (Bit),
      <code>MM.S</code> (Byte), <code>MM</code> (ganzes Modul) oder <code>trigger:&lt;id&gt;</code>.</p>
    <input id="lblFilter" placeholder="🔍 filtern …" style="width:100%;margin-bottom:8px" />
    <div id="lblRows" class="lbl-rows"></div>
    <button id="lblAdd" class="link">＋ Zeile hinzufügen</button>`;
  const rowsEl = $('#lblRows', body);
  let work = Object.entries(LABELS).map(([k, v]) => ({ k, v }));
  const draw = () => {
    const q = ($('#lblFilter', body).value || '').toLowerCase();
    rowsEl.innerHTML = '';
    work.forEach((row, i) => {
      if (q && !(`${row.k} ${row.v}`.toLowerCase().includes(q))) return;
      const r = document.createElement('div');
      r.className = 'lbl-row';
      r.innerHTML = `<input class="lk mono" value="${esc(row.k)}" placeholder="1A.0.0" />
        <input class="lv" value="${esc(row.v)}" placeholder="Name" />
        <button class="link danger x">✕</button>`;
      $('.lk', r).oninput = (e) => row.k = e.target.value.trim();
      $('.lv', r).oninput = (e) => row.v = e.target.value;
      $('.x', r).onclick = () => { work.splice(i, 1); draw(); };
      rowsEl.appendChild(r);
    });
  };
  $('#lblFilter', body).oninput = draw;
  $('#lblAdd', body).onclick = () => { work.push({ k: '', v: '' }); draw(); };
  draw();
  modal('Bezeichnungen verwalten', body, {
    okText: 'Speichern', wide: true, onOk: async () => {
      const map = {};
      for (const { k, v } of work) { const key = k.trim(), name = (v || '').trim(); if (key && name) map[key] = name; }
      LABELS = map;
      await persistLabels();
      renderTriggerList(); renderDetail(); refreshLabelList();
    },
  });
}

// ---- wire up --------------------------------------------------------------
let loadedOnce = false;
export function initAutomations() {
  $('#autoSearch').addEventListener('input', renderTriggerList);
  $('#btnAutoSave').addEventListener('click', saveModel);
  $('#btnAutoNew').addEventListener('click', newAutomation);
  $('#btnLabels').addEventListener('click', openLabels);
  // datalist of labeled addresses for target autocomplete
  const dl = document.createElement('datalist'); dl.id = 'labelList'; document.body.appendChild(dl);
  const tabBtn = document.querySelector('#tabs button[data-tab="automations"]');
  tabBtn.addEventListener('click', async () => {
    if (!loadedOnce) { loadedOnce = true; await loadModel(); }
    refreshLabelList();
  });
}
function refreshLabelList() {
  const dl = $('#labelList'); if (!dl) return;
  dl.innerHTML = Object.keys(LABELS).filter((k) => !k.startsWith('trigger:')).map((k) => `<option value="${k}">${esc(LABELS[k])}</option>`).join('');
}

initAutomations();
