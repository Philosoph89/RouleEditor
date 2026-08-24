// Home-Assistant-Tab: Betriebsart, MQTT-Broker und die Entitätenliste.
//
// Die Liste ist die Kuratierungsoberfläche über der automatisch aus der
// Regelbasis abgeleiteten Registry: melden/nicht melden, Typ korrigieren,
// Klarnamen und Bereich setzen, Jalousie-Laufzeit anpassen — und jede Entität
// direkt testen (derselbe Weg, den ein HA-Kommando nimmt).

const U = (u) => (window.HEIMAUTO_URL ? window.HEIMAUTO_URL(u) : u);
const $ = (s, r = document) => r.querySelector(s);
const api = async (url, opts) => {
  const r = await fetch(U(url), opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r;
};
const J = (body, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hx2 = (n) => (n & 0xff).toString(16).toUpperCase().padStart(2, '0');

const KIND_LABEL = { cover: 'Jalousie', dimmer: 'Dimmer', light: 'Licht', switch: 'Schalter', button: 'Taster' };
const KINDS = ['cover', 'dimmer', 'light', 'switch', 'button'];

let ENT = [];
let OVERRIDES = { entities: {}, modules: {}, areas: {} };
let dirty = false;

function addr(e) {
  const m = hx2(e.module);
  if (e.kind === 'dimmer') return `${m}.${e.levelSub}/${e.cmdSub}`;
  if (e.kind === 'cover') return `${m}.${e.sub}.${e.bitDir}/${e.bitRun}`;
  return `${m}.${e.sub}.${e.bit}`;
}

function stateText(e) {
  const s = e.state;
  if (!s) return '–';
  if (e.kind === 'cover') return `${s.state} ${s.position}%`;
  if (e.kind === 'dimmer') return `${s.state} ${Math.round((s.brightness / 255) * 100)}%`;
  return s.state;
}

function testButtons(e) {
  if (e.kind === 'button') return '<span class="muted small">Eingang</span>';
  if (e.kind === 'cover') {
    return `<button class="mini" data-cmd="OPEN">▲</button><button class="mini" data-cmd="STOP">■</button><button class="mini" data-cmd="CLOSE">▼</button>`;
  }
  if (e.kind === 'dimmer') {
    return `<button class="mini" data-cmd='{"state":"ON","brightness":255}'>100%</button><button class="mini" data-cmd='{"state":"ON","brightness":128}'>50%</button><button class="mini" data-cmd='{"state":"OFF"}'>aus</button>`;
  }
  return `<button class="mini" data-cmd="ON">ein</button><button class="mini" data-cmd="OFF">aus</button>`;
}

function render() {
  const q = ($('#entSearch')?.value || '').toLowerCase().trim();
  const kind = $('#entKind')?.value || '';
  const onlyEnabled = $('#entOnlyEnabled')?.checked;
  const rows = ENT.filter((e) => {
    if (kind && e.kind !== kind) return false;
    if (onlyEnabled && e.enabled === false) return false;
    if (!q) return true;
    return (`${e.name} ${e.id} ${addr(e)} ${KIND_LABEL[e.kind] || e.kind} ${e.area || ''}`).toLowerCase().includes(q);
  });
  $('#entCount').textContent = `— ${ENT.filter((e) => e.enabled !== false).length} gemeldet von ${ENT.length} erkannt`;
  $('#entTable tbody').innerHTML = rows.map((e) => `
    <tr data-id="${e.id}" class="${e.enabled === false ? 'off' : ''}">
      <td><input type="checkbox" data-f="enabled" ${e.enabled === false ? '' : 'checked'} /></td>
      <td><code>${addr(e)}</code>${e.internal ? ' <span class="tag" title="Merker der Regelbasis, kein physischer Ausgang">Merker</span>' : ''}${e.online === false ? ' <span class="tag warn" title="Modul antwortet nicht">offline</span>' : ''}</td>
      <td><select data-f="kind">${KINDS.map((k) => `<option value="${k}" ${k === e.kind ? 'selected' : ''}>${KIND_LABEL[k]}</option>`).join('')}</select></td>
      <td><input data-f="name" value="${esc(e.name)}" /></td>
      <td><input data-f="area" value="${esc(e.area || '')}" placeholder="z. B. Küche" /></td>
      <td>${e.kind === 'cover' ? `<input data-f="travelSec" type="number" min="1" max="300" value="${e.travelSec || 30}" class="tiny" />` : ''}</td>
      <td class="st">${esc(stateText(e))}</td>
      <td>${testButtons(e)}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="muted">keine Treffer</td></tr>';
}

function markDirty() { dirty = true; $('#btnEntSave').classList.add('accent'); }

async function load() {
  const d = await api('/api/entities');
  ENT = d.entities;
  OVERRIDES = d.overrides || OVERRIDES;
  $('#haMode').value = d.mode;
  showMqtt(d.mqtt);
  render();
}

function showMqtt(m) {
  if (!m) return;
  const s = $('#mqStatus');
  s.textContent = m.connected
    ? `verbunden mit ${m.host}:${m.port} · ${m.entities} Entitäten · ${m.stats.published} Statusmeldungen, ${m.stats.commands} Kommandos`
    : (m.lastError ? `nicht verbunden (${m.lastError})` : 'nicht verbunden');
  s.className = m.connected ? 'ok' : 'muted';
}

function logLine(msg) {
  const el = $('#haLog');
  if (!el) return;
  el.textContent = (new Date().toLocaleTimeString() + '  ' + msg + '\n' + el.textContent).slice(0, 8000);
}

// ---- events ---------------------------------------------------------------
$('#entSearch')?.addEventListener('input', render);
$('#entKind')?.addEventListener('change', render);
$('#entOnlyEnabled')?.addEventListener('change', render);

$('#entTable')?.addEventListener('change', (ev) => {
  const tr = ev.target.closest('tr');
  const f = ev.target.dataset.f;
  if (!tr || !f) return;
  const id = tr.dataset.id;
  const e = ENT.find((x) => x.id === id);
  if (!e) return;
  const val = ev.target.type === 'checkbox' ? ev.target.checked
            : (f === 'travelSec' ? Number(ev.target.value) : ev.target.value);
  if (f === 'enabled') e.enabled = val; else e[f] = val;
  OVERRIDES.entities[id] = { ...(OVERRIDES.entities[id] || {}), [f]: f === 'enabled' ? val : val };
  markDirty();
});

$('#entTable')?.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-cmd]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  const raw = btn.dataset.cmd;
  const cmd = raw.trim().startsWith('{') ? JSON.parse(raw) : raw;
  try {
    const r = await api(`/api/entities/${encodeURIComponent(id)}/command`, J({ cmd }));
    logLine(`${id} ← ${raw} → ${JSON.stringify(r.state)}`);
  } catch (e) { logLine(`${id} ← ${raw} FEHLER: ${e.message}`); }
});

$('#btnEntSave')?.addEventListener('click', async () => {
  try {
    await api('/api/entities', J(OVERRIDES, 'PUT'));
    dirty = false;
    $('#btnEntSave').classList.remove('accent');
    await load();
    logLine('Entitäten gespeichert und Discovery gesendet');
  } catch (e) { logLine('Speichern fehlgeschlagen: ' + e.message); }
});

$('#btnHaMode')?.addEventListener('click', async () => {
  const r = await api('/api/ha/mode', J({ mode: $('#haMode').value }));
  $('#haModeInfo').textContent = `aktiv: ${r.mode} (Regelbasis ${r.rules ? 'läuft' : 'aus'})`;
  logLine('Betriebsart: ' + r.mode);
});

$('#btnMqConnect')?.addEventListener('click', async () => {
  try {
    const r = await api('/api/ha/mqtt', J({
      host: $('#mqHost').value, port: Number($('#mqPort').value),
      username: $('#mqUser').value || undefined, password: $('#mqPass').value || undefined,
      base: $('#mqBase').value, discoveryPrefix: $('#mqPrefix').value,
    }));
    showMqtt(r.mqtt);
    logLine('MQTT verbunden');
    await load();
  } catch (e) { logLine('MQTT-Verbindung fehlgeschlagen: ' + e.message); showMqtt({ connected: false, lastError: e.message }); }
});

$('#btnMqDisconnect')?.addEventListener('click', async () => {
  const r = await api('/api/ha/mqtt', J({ connect: false }));
  showMqtt(r.mqtt);
  logLine('MQTT getrennt');
});

$('#btnMqDiscovery')?.addEventListener('click', async () => {
  const r = await api('/api/ha/discovery', J({}));
  logLine(`Discovery neu gesendet: ${r.published} Entitäten`);
});

// live updates over the existing WebSocket
window.addEventListener('heimauto-ws', (ev) => {
  const m = ev.detail;
  if (m.type === 'entity-state') {
    const e = ENT.find((x) => x.id === m.id);
    if (e) {
      e.state = m.state;
      const td = document.querySelector(`#entTable tr[data-id="${m.id}"] .st`);
      if (td) td.textContent = stateText(e);
    }
  } else if (m.type === 'ha-log') {
    logLine(m.msg);
  } else if (m.type === 'ha-mqtt') {
    showMqtt(m.mqtt);
  } else if (m.type === 'ha-mode') {
    $('#haMode').value = m.mode;
    $('#haModeInfo').textContent = `aktiv: ${m.mode} (Regelbasis ${m.rules ? 'läuft' : 'aus'})`;
  } else if (m.type === 'discover' || m.type === 'entities') {
    load().catch(() => {});
  }
});

load().catch((e) => logLine('Laden fehlgeschlagen: ' + e.message));
