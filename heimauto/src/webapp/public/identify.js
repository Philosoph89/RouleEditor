// Live-Zuordnung: Taster drücken → sofort sehen, welcher das ist.
//
// Der Server schickt zu jedem eingehenden Bitwechsel ein 'ident'-Ereignis mit
// allem, was über die Adresse bekannt ist (Klarname, Entität, Event-Key, die
// Regelketten der Original-Konfiguration und deren Ausgänge). Läuft die
// Regelbasis mit, kommt zusätzlich ein 'ident' mit source='regel' — dann steht
// in der Karte, was tatsächlich geschaltet wurde.

const U = (u) => (window.HEIMAUTO_URL ? window.HEIMAUTO_URL(u) : u);
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = async (url, opts) => {
  const r = await fetch(U(url), opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r;
};
const J = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const KIND_LABEL = { cover: 'Jalousie', dimmer: 'Dimmer', light: 'Licht', switch: 'Schalter',
                     button: 'Taster', fan: 'Lüftung', level: 'Stufenschalter' };
const HIST_MAX = 30;

let history = [];
let current = null;
let running = false;

// Ein kurzer Klick, damit man beim Drücken an der Wand nicht auf den Schirm
// schauen muss (WebAudio, kein Asset nötig).
let audio = null;
function beep(up) {
  if (!$('#identSound')?.checked) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = up ? 880 : 440;
    g.gain.value = 0.05;
    o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + 0.07);
  } catch { /* egal */ }
}

function chainHtml(c, i) {
  return `<div class="chain">
    <div class="chain-head">Kette ${i + 1}</div>
    ${c.when.length ? `<div class="chain-when"><b>WENN</b> ${c.when.map((l) => `<code>${esc(l)}</code>`).join(' <span class="muted">und</span> ')}</div>` : ''}
    ${c.then.length ? `<div class="chain-then"><b>DANN</b> ${c.then.map((l) => `<code>${esc(l)}</code>`).join(' ')}</div>` : ''}
  </div>`;
}

function devHtml(o) {
  const name = o.entity?.name || o.label;
  return `<span class="dev ${o.entity ? '' : 'unknown'}">
    <code>${esc(o.token)}</code>
    ${name ? `<b>${esc(name)}</b>` : '<i class="muted">unbenannt</i>'}
    ${o.entity ? `<span class="tag">${KIND_LABEL[o.entity.kind] || o.entity.kind}</span>` : ''}
    ${o.entity && o.entity.enabled === false ? '<span class="tag warn">nicht gemeldet</span>' : ''}
    ${o.relative ? '<span class="tag" title="relative Adresse 00 = auslösendes Modul">relativ</span>' : ''}
  </span>`;
}

// Ein gelaufener Ausgang ist ein ganzes Sub-Byte: alle Geräte daran, mit Zustand.
function firedHtml(f) {
  if (!f.devices?.length) {
    return `<span class="dev unknown"><code>${esc(f.token)}</code>
      <i class="muted">${esc(f.role || 'kein Gerät zugeordnet')}</i>
      <span class="muted small">${esc(f.hex)}</span></span>`;
  }
  return f.devices.map((d) => `<span class="dev">
      <code>${esc(f.token)}</code>
      <b>${esc(d.entity.name)}</b>
      <span class="tag">${KIND_LABEL[d.entity.kind] || d.entity.kind}</span>
      <span class="state ${d.on ? 'on' : 'off'}">${esc(d.state)}</span>
      <span class="muted small">${esc(f.hex)}</span>
    </span>`).join('');
}

function cardHtml(ev) {
  const name = ev.entity?.name || ev.label;
  const isRule = ev.source === 'regel';
  return `
    <div class="ident-top">
      <div class="ident-addr">
        <span class="ident-badge ${ev.pressed ? 'on' : 'off'}">${ev.pressed ? 'gedrückt' : 'gelöst'}</span>
        <code class="big">${esc(ev.token)}</code>
        <span class="muted small">Modul ${esc(ev.hexAddr)} · Sub ${ev.sub} · Bit ${ev.bit} · Event-Key ${esc(ev.eventKeyHex)}</span>
      </div>
      <div class="ident-name">
        <input id="identName" value="${esc(name || '')}" placeholder="Klarname vergeben, z. B. „Taster Küche Ost“ …" />
        <input id="identArea" value="${esc(ev.entity?.area || '')}" placeholder="Bereich" />
        <label class="check" title="Diese Adresse kommt in der Regelbasis nicht als Auslöser vor — als Entität anlegen, damit Home Assistant sie sieht.">
          <input id="identCreate" type="checkbox" ${ev.entity ? 'disabled' : 'checked'} /> an HA melden
        </label>
        <button id="btnIdentSave">Übernehmen</button>
        <span id="identSaved" class="ok small"></span>
      </div>
    </div>
    <div class="ident-body">
      <div class="ident-col">
        <h3>Entität</h3>
        ${ev.entity
          ? `<div>${devHtml({ token: ev.token, entity: ev.entity })}</div>
             ${ev.entity.connector ? `<div class="sheet"><b>${esc(ev.entity.connector)}</b> ${esc(ev.entity.sheet || '')}</div>` : ''}
             <div class="muted small">ID <code>${esc(ev.entity.id)}</code>${ev.entity.area ? ' · ' + esc(ev.entity.area) : ''}${ev.entity.source === 'manual' ? ' · von Hand angelegt' : ''}${ev.entity.enabled === false ? ' — wird an Home Assistant <b>nicht</b> gemeldet' : ''}</div>`
          : `<div class="muted">Noch keine Entität: diese Adresse kommt in der Regelbasis nicht als Auslöser vor.
              Name eintragen und „an HA melden" angehakt lassen — dann wird daraus ein <code>binary_sensor</code>.</div>`}
      </div>
      <div class="ident-col">
        <h3>${isRule ? `Geschaltet (${ev.ran ?? 0} ${ev.ran === 1 ? 'Kette' : 'Ketten'} gelaufen)` : 'Original-Konfiguration'}</h3>
        ${isRule
          ? (ev.fired?.length
              ? `<div class="devs">${ev.fired.map(firedHtml).join('')}</div>`
              : `<div class="muted">Kein Ausgang geschaltet${ev.ran ? ' (die Ketten liefen, aber ohne Ausgangswirkung — z. B. nur ein Merker oder ein Timer)' : ''}.</div>
                 ${ev.outputs.length ? `<div class="muted small" style="margin-top:6px">Laut Konfiguration betroffene Geräte:</div>
                 <div class="devs">${ev.outputs.map(devHtml).join('')}</div>` : ''}`)
          : (ev.outputs.length
              ? `<div class="devs">${ev.outputs.map(devHtml).join('')}</div>`
              : '<div class="muted">Dieser Eingang schaltet in der Original-Konfiguration nichts.</div>')}
      </div>
    </div>
    ${ev.chains.length
      ? `<details class="ident-chains" ${isRule ? 'open' : ''}>
           <summary>${ev.chains.length} Regelkette${ev.chains.length === 1 ? '' : 'n'} der Original-Konfiguration</summary>
           ${ev.chains.map(chainHtml).join('')}
         </details>`
      : ''}
  `;
}

function histHtml(ev) {
  const name = ev.entity?.name || ev.label;
  const outs = (ev.source === 'regel' ? ev.fired : ev.outputs) || [];
  const outNames = outs.map((o) => {
    const n = o.entity?.name || o.label || (o.role ? `${o.token} (${o.role})` : o.token);
    return o.state ? `${n} (${o.state})` : n;
  }).slice(0, 3);
  return `<div class="hist-row ${ev.known ? '' : 'unknown'}" data-token="${esc(ev.token)}">
    <span class="hist-time">${new Date(ev.t).toLocaleTimeString()}</span>
    <span class="hist-badge ${ev.pressed ? 'on' : 'off'}">${ev.pressed ? '▼' : '▲'}</span>
    <code>${esc(ev.token)}</code>
    <span class="hist-name">${name ? esc(name) : '<i class="muted">unbenannt</i>'}</span>
    ${ev.entity?.connector ? `<span class="muted small">${esc(ev.entity.connector)}</span>` : ''}
    <span class="muted small">${ev.source === 'regel' ? '⚙ Regel' : ''} ${outNames.length ? '→ ' + esc(outNames.join(', ')) : ''}</span>
  </div>`;
}

function renderHistory() {
  const onlyUnknown = $('#identOnlyUnknown')?.checked;
  const rows = history.filter((e) => !onlyUnknown || !e.known);
  $('#identHistory').innerHTML = rows.length
    ? rows.map(histHtml).join('')
    : '<div class="muted">noch nichts empfangen</div>';
}

function show(ev) {
  current = ev;
  const card = $('#identCard');
  card.classList.remove('empty');
  card.classList.add('flash');
  card.innerHTML = cardHtml(ev);
  setTimeout(() => card.classList.remove('flash'), 400);
  const input = $('#identName');
  // Fokus nur setzen, wenn der Name noch fehlt — sonst tippt man beim nächsten
  // Tastendruck in ein Feld, das gerade ersetzt wurde.
  if (input && !input.value) input.focus();
}

async function saveName() {
  if (!current) return;
  const name = $('#identName').value.trim();
  const area = $('#identArea').value.trim();
  try {
    const create = $('#identCreate')?.checked && !current.entity;
    const r = await api('/api/identify/label', J({ token: current.token, name, area, create,
                                                  entityId: current.entity?.id || current.suggestedId }));
    $('#identSaved').textContent = r.created ? '✓ gespeichert und als Entität angelegt' : '✓ gespeichert';
    if (r.entity) current.entity = { id: r.entity.id, name: r.entity.name, kind: r.entity.kind,
                                     area: r.entity.area, enabled: r.entity.enabled !== false,
                                     source: r.entity.source };
    current.label = name || null;
    if (current.entity) { current.entity.name = name || current.entity.name; current.entity.area = area || null; }
    current.known = Boolean(name);
    history = history.map((h) => (h.token === current.token ? { ...h, label: current.label, known: current.known } : h));
    renderHistory();
  } catch (e) {
    $('#identSaved').textContent = 'Fehler: ' + e.message;
  }
}

// ---- Ereignisse ------------------------------------------------------------
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target?.id === 'identName') { ev.preventDefault(); saveName(); }
});
document.addEventListener('click', (ev) => {
  if (ev.target?.id === 'btnIdentSave') saveName();
  const tab = ev.target?.closest?.('#tabs button[data-tab="ident"]');
  if (tab) tab.classList.remove('has-news');
});

$('#identOnlyUnknown')?.addEventListener('change', renderHistory);
$('#btnIdentClear')?.addEventListener('click', () => { history = []; renderHistory(); });

$('#identHistory')?.addEventListener('click', (ev) => {
  const row = ev.target.closest('.hist-row');
  if (!row) return;
  const e = history.find((h) => h.token === row.dataset.token);
  if (e) show(e);
});

// Starten heißt: Polling + Live-Automat laufen lassen — ohne Polls schickt die
// Anlage nichts. Die Betriebsart bleibt unangetastet.
$('#btnIdentStart')?.addEventListener('click', async () => {
  const info = $('#identInfo');
  try {
    info.textContent = 'starte …';
    const bus = await api('/api/bus/poll').catch(() => null);
    if (!bus?.status?.running) {
      if (!bus?.discovered?.length) {
        info.textContent = 'Erst im Monitor „Module suchen" ausführen (Port muss offen sein).';
        return;
      }
      await api('/api/bus/poll', J({ run: true }));
    }
    const r = await api('/api/automat', J({ run: true, windowMs: 80 }));
    running = true;
    info.textContent = `aktiv — ${r.modules} Module, warte auf Eingänge`;
  } catch (e) {
    info.textContent = 'Fehler: ' + e.message;
  }
});

$('#btnIdentStop')?.addEventListener('click', async () => {
  await api('/api/automat', J({ run: false })).catch(() => {});
  running = false;
  $('#identInfo').textContent = 'gestoppt (Polling läuft weiter)';
});

window.addEventListener('heimauto-ws', (ev) => {
  const m = ev.detail;
  if (m.type !== 'ident') {
    if (m.type === 'automat-status') $('#identInfo').textContent = m.running ? 'aktiv — warte auf Eingänge' : 'gestoppt';
    return;
  }
  // Ein Regel-Ereignis zur selben Adresse ersetzt die eben gezeigte
  // Eingangskarte (es weiß mehr), statt einen zweiten Eintrag zu erzeugen.
  if (m.source === 'regel' && history[0]?.token === m.token && history[0].source === 'eingang') {
    history[0] = m;
  } else {
    history.unshift(m);
    history = history.slice(0, HIST_MAX);
  }
  beep(m.pressed);
  show(m);
  renderHistory();
  // Wer gerade in einem anderen Tab arbeitet, soll sehen, dass etwas
  // hereingekommen ist — sonst drückt man an der Wand und merkt nichts.
  const btn = document.querySelector('#tabs button[data-tab="ident"]');
  if (btn && !btn.classList.contains('active')) btn.classList.add('has-news');
});

renderHistory();
