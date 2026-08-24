// RouleEditor Web — frontend (vanilla ES modules, no build step).

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
// Base path of the page. Inside the Home Assistant add-on the UI is served
// behind ingress at /api/hassio_ingress/<token>/, so every absolute "/api/..."
// URL has to be prefixed with that path (ingress strips it again before the
// request reaches us).
export const BASE = location.pathname.endsWith('/')
  ? location.pathname : location.pathname.replace(/[^/]*$/, '');
window.HEIMAUTO_BASE = BASE;
const withBase = (url) => (typeof url === 'string' && url.startsWith('/') ? BASE + url.slice(1) : url);
window.HEIMAUTO_URL = withBase;
const api = async (url, opts) => {
  const r = await fetch(withBase(url), opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r;
};
const hx = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');

let META = { opcodes: [], serialChoices: {} };
let RULES = [];
let selected = null;

// ---------------- tabs ----------------
$$('#tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('#tabs button').forEach((x) => x.classList.remove('active'));
    $$('.tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('#tab-' + b.dataset.tab).classList.add('active');
  })
);

// ---------------- WebSocket ----------------
let ws;
function connectWS() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE}ws`);
  ws.onopen = () => { $('#wsDot').className = 'dot on'; $('#wsLabel').textContent = 'WS verbunden'; };
  ws.onclose = () => { $('#wsDot').className = 'dot off'; $('#wsLabel').textContent = 'WS getrennt'; setTimeout(connectWS, 1500); };
  ws.onmessage = (ev) => handleWS(JSON.parse(ev.data));
}
function handleWS(m) {
  // re-broadcast to the other frontend modules (ha.js listens for this)
  window.dispatchEvent(new CustomEvent('heimauto-ws', { detail: m }));
  switch (m.type) {
    case 'hello': applySerialStatus(m.serial); break;
    case 'serial-status': applySerialStatus(m.status); break;
    case 'rx': logMon('rx', m.hex, m.t); break;
    case 'tx': logMon('tx', m.hex, m.t); break;
    case 'serial-error': logMon('err', m.msg); break;
    case 'sim-state': renderSim(m.state); break;
    case 'frame': onFrame(m); break;
    case 'deframer-stats':
      $('#resyncs').textContent = m.stats.resyncs;
      $('#overruns').textContent = m.stats.overruns;
      break;
    case 'tick': onTick(m); break;
    case 'discover': onDiscover(m); break;
    case 'poll-status': onPollStatus(m.status); break;
    case 'poll': break; // (leises TX-Event, im Monitor schon als tx sichtbar)
    case 'automat': onAutomat(m); break;
    case 'automat-status': $('#automatInfo').textContent = m.running ? 'aktiv — wartet auf Eingänge' : 'gestoppt'; break;
  }
}

let discovered = [];
function onAutomat(m) {
  const el = $('#automat'); if (!el) return;
  const div = document.createElement('div');
  const time = new Date(m.t).toLocaleTimeString();
  const inp = `M0x${m.module.toString(16).padStart(2,'0')}.${m.sub}.${m.bit}=${m.rising?1:0}`;
  const ev = `Event 0x${m.eventKey.toString(16).toUpperCase()}`;
  if (m.outputs && m.outputs.length) {
    const outs = m.outputs.map((o) => `M0x${o.module.toString(16).padStart(2,'0')}.${o.sub}=0x${o.value.toString(16).padStart(2,'0')} (Bit0=${o.value&1?'AN':'AUS'})`).join(', ');
    div.className = 'line frame';
    div.textContent = `${time}  EINGANG ${inp} → ${ev} → REGEL feuert → AUSGANG: ${outs}`;
  } else {
    div.className = 'line sys';
    div.textContent = `${time}  Eingang ${inp} → ${ev} → ${m.ran?'Regel: keine Aktion (Bedingung false)':'keine passende Regel'}`;
  }
  el.appendChild(div);
  while (el.childElementCount > 400) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}
function onDiscover(m) {
  discovered = m.modules.map((x) => x.addr);
  $('#pollInfo').textContent = `${m.modules.length} Module: ` + m.modules.map((x) => x.hex).join(' ');
  logMon('sys', `Discovery: ${m.modules.length} Module gefunden — ` + m.modules.map((x) => x.hex + '=' + x.reply).join('  '));
}
function onPollStatus(st) {
  $('#pollInfo').textContent = st.running
    ? `Polling läuft: ${st.count} Module @ ${st.intervalMs} ms`
    : (discovered.length ? `${discovered.length} Module bekannt` : 'gestoppt');
}

let frameCount = 0;
function onFrame(m) {
  frameCount++;
  $('#frameCount').textContent = frameCount;
  if (!$('#showFrames').checked) return;
  const mon = $('#monitor');
  const div = document.createElement('div');
  div.className = 'line frame';
  const chk = m.checksumOk ? '⊕ok' : `⊕${m.checksum}`;
  const flags = m.flagErrors ? ` flagErr=${m.flagErrors}` : '';
  div.textContent = `${new Date(m.t).toLocaleTimeString()}  FRAME [${m.classes}] ${chk}${flags}  ${fmtHex(m.hex)}`;
  mon.appendChild(div);
  if ($('#autoscroll').checked) mon.scrollTop = mon.scrollHeight;
}
function onTick(m) {
  const e = m.events || {};
  const parts = [];
  if (e.shortTimer) parts.push('ST');
  if (e.longTimer) parts.push('LT');
  if (e.minuteChanged) parts.push('Minute→Key8');
  const dt = m.dateTime || {};
  $('#tbInfo').textContent = `${String(dt.hour).padStart(2, '0')}:${String(dt.minute).padStart(2, '0')}:${String(dt.second).padStart(2, '0')}`
    + (parts.length ? '  ' + parts.join('+') : '');
  if (e.minuteChanged) simLog('Minutenwechsel → Event-Key 8 ausgeführt');
}

// ---------------- settings ----------------
function fillSelect(el, values, current) {
  el.innerHTML = '';
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    if (String(v) === String(current)) o.selected = true;
    el.appendChild(o);
  }
}
async function loadMeta() {
  META = await api('/api/opcodes');
  fillSelect($('#cfgParity'), META.serialChoices.parity, 'none');
  fillSelect($('#cfgDataBits'), META.serialChoices.dataBits, 8);
  fillSelect($('#cfgStopBits'), META.serialChoices.stopBits, 1);
  $('#baudList').innerHTML = META.serialChoices.baudRate.map((b) => `<option value="${b}">`).join('');
}
async function refreshPorts() {
  const { ports, status } = await api('/api/serial/ports');
  const sel = $('#cfgPort');
  sel.innerHTML = '';
  for (const p of ports) {
    const o = document.createElement('option');
    o.value = p.path;
    o.textContent = p.mock ? 'MOCK — Loopback-Simulator' : `${p.path}${p.manufacturer ? ' — ' + p.manufacturer : ''}`;
    sel.appendChild(o);
  }
  if (status.config?.path) sel.value = status.config.path;
  $('#mockHint').textContent = status.serialportAvailable
    ? 'Echte serielle Ports werden erkannt. MOCK bleibt zum Testen ohne Hardware verfügbar.'
    : 'Natives serialport-Modul nicht verfügbar — nur MOCK-Loopback. (npm install im webapp-Ordner ausführen.)';
  applySerialStatus(status);
}
function applySerialStatus(s) {
  if (!s) return;
  const open = s.open;
  $('#serialDot').className = 'dot ' + (open ? 'on' : 'off');
  $('#serialLabel').textContent = open ? (s.mock ? 'MOCK offen' : `${s.config.path} offen`) : 'Port zu';
  if (s.stats) { $('#rxBytes').textContent = s.stats.rxBytes; $('#txBytes').textContent = s.stats.txBytes; }
  $('#serialInfo').textContent = open
    ? `${s.mock ? 'MOCK' : s.config.path} @ ${s.config.baudRate} ${s.config.dataBits}${s.config.parity[0].toUpperCase()}${s.config.stopBits}`
    : '';
}
$('#btnRefreshPorts').onclick = refreshPorts;
$('#btnOpen').onclick = async () => {
  const cfg = {
    path: $('#cfgPort').value,
    baudRate: Number($('#cfgBaud').value),
    parity: $('#cfgParity').value,
    dataBits: Number($('#cfgDataBits').value),
    stopBits: Number($('#cfgStopBits').value),
    rtscts: $('#cfgRtscts').checked,
  };
  try { applySerialStatus(await api('/api/serial/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) })); logMon('sys', 'Port geöffnet'); }
  catch (e) { logMon('err', e.message); }
};
$('#btnClose').onclick = async () => { applySerialStatus(await api('/api/serial/close', { method: 'POST' })); logMon('sys', 'Port geschlossen'); };

// ---------------- monitor ----------------
function fmtHex(hex) { return (hex.match(/../g) || []).join(' '); }
function logMon(kind, hex, t) {
  const mon = $('#monitor');
  const div = document.createElement('div');
  const time = new Date(t || Date.now()).toLocaleTimeString();
  const tag = { rx: 'RX', tx: 'TX', err: 'ERR', sys: '··' }[kind] || '··';
  const body = kind === 'rx' || kind === 'tx' ? fmtHex(hex) : hex;
  div.className = 'line ' + kind;
  div.textContent = `${time}  ${tag}  ${body}`;
  mon.appendChild(div);
  while (mon.childElementCount > 1000) mon.removeChild(mon.firstChild);
  if ($('#autoscroll').checked) mon.scrollTop = mon.scrollHeight;
}
$('#btnSend').onclick = async () => {
  try { await api('/api/serial/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hex: $('#txHex').value }) }); }
  catch (e) { logMon('err', e.message); }
};
$('#txHex').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnSend').click(); });
$('#btnClearMon').onclick = () => ($('#monitor').innerHTML = '');
$('#btnDiscover').onclick = async () => {
  logMon('sys', 'Suche Module (Poll-Scan 0x00..0xFF) …');
  try { const r = await api('/api/bus/discover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start: 0, end: 255, waitMs: 25 }) });
    if (!r.count) logMon('err', 'Keine Module gefunden — Port offen? Anlage versorgt?'); }
  catch (e) { logMon('err', e.message); }
};
$('#btnPollStart').onclick = async () => {
  try { const r = await api('/api/bus/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run: true, intervalMs: Number($('#pollInterval').value) }) });
    onPollStatus(r.status); logMon('sys', 'Polling gestartet'); }
  catch (e) { logMon('err', e.message); }
};
$('#btnPollStop').onclick = async () => { const r = await api('/api/bus/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run: false }) }); onPollStatus(r.status); logMon('sys', 'Polling gestoppt'); };
$('#btnAutomatStart').onclick = async () => {
  const timebase = $('#cbTimebase').checked;
  if (timebase && !confirm('Zeitplan-Regeln aktivieren?\n\nDie Anlage schaltet dann selbständig nach Uhrzeit (z.B. Rolladen 9:30, Außenlicht 23:00).')) return;
  const r = await api('/api/automat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run: true, windowMs: 80, timebase }) });
  $('#automatInfo').textContent = r.running ? `aktiv — ${r.modules} Module${r.timebase ? ' + Zeitplan' : ''}` : 'nicht aktiv';
  logMon('sys', 'Live-Automat gestartet' + (r.timers ? ' (Timer aktiv' + (r.timebase ? ', Zeitplan aktiv)' : ')') : ''));
};
$('#btnAutomatStop').onclick = async () => { await api('/api/automat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run: false }) }); $('#automatInfo').textContent = 'gestoppt'; logMon('sys', 'Live-Automat gestoppt'); };

// ---------------- rule base / editor ----------------
async function loadRuleBase() {
  const rb = await api('/api/rulebase');
  const s = rb.summary;
  $('#rbSummary').innerHTML = `
    <span>Index-Einträge <b>${s.indexEntries}</b></span>
    <span>Regelworte <b>${s.commandWords}</b></span>
    <span>Prüfsumme <span class="${s.checksumOk ? 'ok' : 'bad'}">${s.storedChecksum} ${s.checksumOk ? '✓' : '✗'}</span></span>
    <span>Balancer <b>${s.hasBalancer ? 'ja' : 'nein'}</b></span>`;
  const data = await api('/api/rulebase/rules');
  RULES = data.rules;
  renderRules();
}
function ruleTypeLabel(r) { return r.exact ? r.exact.kind : ''; }
function opcodeLabel(r) {
  if (!r.exact) return '';
  const v = r.exact.verified ? '' : ' ~';
  return (r.exact.name || '') + v;
}
function ruleSource(r) { return r.source || ''; }
function ruleAddr(r) {
  if (!r.fields) return '';
  const f = r.fields, k = r.exact ? r.exact.kind : '';
  const bit = k.startsWith('bit') ? '.' + f.dstBit : '';
  const dst = `M${f.dstModuleAddr}.${f.dstSub}${bit}`;
  let src = '';
  if (r.exact && r.exact.srcMode === 'k') src = `k=${f.const8}`;
  else src = `M(${f.srcModAddrByte}).${f.srcSub}${k === 'bit-2op' ? '.' + f.srcBit : ''}`;
  return dst + ' ← ' + src;
}
function renderRules() {
  const filter = $('#ruleFilter').value.trim().toLowerCase();
  const tbody = $('#rulesTable tbody');
  tbody.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const r of RULES) {
    const label = opcodeLabel(r);
    if (filter && !(r.hex.toLowerCase().includes(filter) || label.toLowerCase().includes(filter) || ruleSource(r).toLowerCase().includes(filter))) continue;
    const tr = document.createElement('tr');
    tr.dataset.i = r.i;
    if (selected === r.i) tr.classList.add('sel');
    tr.innerHTML = `<td>${r.i}</td><td class="hex">${r.hex}</td><td>${ruleTypeLabel(r)}</td>
      <td>${label}</td><td class="hex small">${ruleSource(r)}</td><td class="mono small">${ruleAddr(r)}</td>
      <td><button class="secondary del" data-i="${r.i}">✕</button></td>`;
    tr.addEventListener('click', (e) => { if (!e.target.classList.contains('del')) selectRule(r.i); });
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  tbody.querySelectorAll('.del').forEach((b) =>
    b.addEventListener('click', async () => {
      await api('/api/rulebase/rules/' + b.dataset.i, { method: 'DELETE' });
      await loadRuleBase();
    })
  );
}
function selectRule(i) {
  selected = i;
  $$('#rulesTable tbody tr').forEach((tr) => tr.classList.toggle('sel', Number(tr.dataset.i) === i));
  const r = RULES.find((x) => x.i === i);
  if (!r) return;
  const c = r.canonical || {};
  const ex = r.exact || {};
  $('#ruleEditBody').innerHTML = `
    <p class="small"><b>${ex.name || ''}</b>${ex.verified ? '' : ' <span class="muted">(~)</span>'}
       ${ex.op != null ? `<span class="muted">Opcode ${ex.op}</span>` : ''}</p>
    <p class="muted small">${ruleAddr(r)}</p>
    <h4 class="muted small">Kanonische Felder (byte‑exakt)</h4>
    <div class="grid">
      <label>bit31<input id="cBit31" type="number" min="0" max="1" value="${c.bit31}" /></label>
      <label>dstBit / cmpOp<input id="cDstBit" type="number" min="0" max="7" value="${c.dstBit}" /></label>
      <label>dstModAddr<input id="cDstMod" type="number" min="0" max="255" value="${c.dstModAddrByte}" /></label>
      <label>dstSub<input id="cDstSub" type="number" min="0" max="15" value="${c.dstSub}" /></label>
      <label>G (Kategorie)<input id="cG" type="number" min="0" max="15" value="${c.G}" /></label>
      <label>srcModAddr<input id="cSrcMod" type="number" min="0" max="255" value="${c.srcModAddrByte}" /></label>
      <label>srcSub<input id="cSrcSub" type="number" min="0" max="15" value="${c.srcSub}" /></label>
      <label>Rohwort (hex)<input id="edRaw" class="mono" value="${r.hex}" /></label>
    </div>
    <div class="row"><button id="edApply">Felder übernehmen</button><button id="edFromRaw" class="secondary">aus Rohwort</button></div>
    <p class="muted small">Die 7 kanonischen Felder decken alle 32 Bit überlappungsfrei ab
    und werden byte‑exakt zurückgeschrieben.</p>
    <details><summary class="muted small">Befehlssatz‑Referenz (83 Opcodes)</summary>
      <div id="opcodeRef" class="opref small mono"></div></details>`;
  const ref = $('#opcodeRef');
  ref.innerHTML = META.opcodes.filter((o) => o.label)
    .map((o) => `<div><span class="muted">${String(o.index).padStart(2, '0')}</span> ${o.label}</div>`).join('');
  $('#edApply').onclick = () => applyRuleEdit(i, false);
  $('#edFromRaw').onclick = () => applyRuleEdit(i, true);
}
async function applyRuleEdit(i, fromRaw) {
  let body;
  if (fromRaw) {
    body = { raw: parseInt($('#edRaw').value.replace(/[^0-9a-fA-F]/g, ''), 16) >>> 0 };
  } else {
    body = {
      canonical: {
        bit31: Number($('#cBit31').value), dstBit: Number($('#cDstBit').value),
        dstModAddrByte: Number($('#cDstMod').value), dstSub: Number($('#cDstSub').value),
        G: Number($('#cG').value), srcModAddrByte: Number($('#cSrcMod').value),
        srcSub: Number($('#cSrcSub').value),
      },
    };
  }
  await api('/api/rulebase/rules/' + i, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await loadRuleBase();
  selectRule(i);
}
$('#ruleFilter').addEventListener('input', renderRules);
$('#btnReloadRb').onclick = loadRuleBase;
$('#btnSave').onclick = async () => { const r = await api('/api/rulebase/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rebuild: true }) }); alert('Gespeichert: ' + r.path + ' (' + r.bytes + ' B)'); };
$('#fileImport').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  try {
    const r = await api('/api/rulebase/import', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf });
    logMon('sys', 'Importiert: ' + JSON.stringify(r.summary));
    await loadRuleBase();
  } catch (err) { alert('Import fehlgeschlagen: ' + err.message); }
});

// ---------------- simulator ----------------
const J = (o) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
$('#btnRegister').onclick = async () => {
  const r = await api('/api/sim/register', J({ addr: Number($('#regAddr').value) }));
  simLog(`Modul ${r.addr} registriert → Slot ${r.slot}`); refreshSim();
};
$('#btnRun1').onclick = async () => {
  const r = await api('/api/sim/run', J({ passes: 1 }));
  simLog(`Auswertung: ${r.results[0].fired} Worte ausgeführt (${r.results[0].runs} Regel-Runs)`); refreshSim();
};
$('#btnSimReset').onclick = async () => { await api('/api/sim/reset', { method: 'POST' }); simLog('Reset'); refreshSim(); };
$('#btnInject').onclick = async () => {
  const r = await api('/api/sim/inject', J({ mod: Number($('#injMod').value), sub: Number($('#injSub').value), value: Number($('#injVal').value) }));
  simLog(`Inject M${$('#injMod').value}.${$('#injSub').value}=${$('#injVal').value} → ${r.steps} Propagationsschritte`); refreshSim();
};
$('#btnTick').onclick = async () => { const r = await api('/api/bus/tick', { method: 'POST' }); simLog(`Tick: ${JSON.stringify(r.events)}${r.keys.length ? ' keys=' + r.keys : ''}`); refreshSim(); };
$('#btnTimeRun').onclick = async () => { await api('/api/bus/timebase', J({ run: true, intervalMs: 1000 })); simLog('Zeitbasis gestartet (1 s/Tick)'); };
$('#btnTimeStop').onclick = async () => { await api('/api/bus/timebase', J({ run: false })); simLog('Zeitbasis gestoppt'); };
$('#btnSetBit').onclick = async () => {
  await api('/api/sim/setbit', J({ mod: Number($('#sbMod').value), sub: Number($('#sbSub').value), bit: Number($('#sbBit').value), value: Number($('#sbVal').value) }));
  simLog(`Bit M${$('#sbMod').value}.${$('#sbSub').value}.${$('#sbBit').value} := ${$('#sbVal').value}`); refreshSim();
};
async function refreshSim() { renderSim(await api('/api/sim/state')); }
function renderSim(state) {
  const grid = $('#modGrid');
  grid.innerHTML = '';
  if (!state.modules.length) {
    grid.innerHTML = '<div class="muted small" style="grid-column:1/-1">Noch keine Module registriert. Oben ein Modul registrieren oder ein Byte injizieren.</div>';
  }
  for (const m of state.modules) {
    for (const c of m.subs) {
      const bits = c.value.toString(2).padStart(8, '0');
      const cell = document.createElement('div');
      cell.className = 'modcell' + (c.value ? ' nz' : '');
      cell.innerHTML = `<span class="m">M${m.module}.${c.sub}</span>${c.value}`;
      cell.title = `Modul ${m.module} (Slot ${m.slot}) Sub ${c.sub} = ${c.value}  bits=${bits}`;
      grid.appendChild(cell);
    }
  }
  // Timers are id-addressed lists (max 31 entries each), not fixed registers.
  const tv = $('#timerView');
  tv.innerHTML = '';
  const addTimer = (kind, e) => {
    const d = document.createElement('div');
    d.className = 'timer' + (e.value ? ' nz' : '');
    d.textContent = `${kind} ${e.id}:${e.value}`;
    d.title = `${kind}-Timer id=0x${e.id.toString(16).toUpperCase()} Wert=${e.value}`;
    tv.appendChild(d);
  };
  (state.st || []).forEach((e) => addTimer('ST', e));
  (state.lt || []).forEach((e) => addTimer('LT', e));
  if (!(state.st || []).length && !(state.lt || []).length) {
    tv.innerHTML = '<div class="muted small" style="grid-column:1/-1">Keine Timer aktiv (werden bei Bedarf angelegt, max. 31 je Typ).</div>';
  }
}
function simLog(msg) {
  const el = $('#simLog');
  const div = document.createElement('div');
  div.className = 'line sys';
  div.textContent = new Date().toLocaleTimeString() + '  ' + msg;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// ---------------- boot ----------------
(async function boot() {
  connectWS();
  await loadMeta();
  await refreshPorts();
  await loadRuleBase();
  await refreshSim();
})();
