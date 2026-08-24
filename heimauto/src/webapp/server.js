// RouleEditor Web — Express + WebSocket server.
//
// Reproduces the RouleEditor V2.103 functions (rule-base editor, simulator,
// serial console) and extends the serial configuration: any detected port and
// any baud rate / parity / data-bit / stop-bit combination.

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { RuleBase } from './src/hrb.js';
import { OPCODES, RESERVED, decodeRule, encodeRule, describeRule, classifyRule, opcodeClass } from './src/opcodes.js';
import { extractFields, classify as classifyExact, describe as describeExact, canonicalFields, packCanonical } from './src/ruleword.js';
import { SerialManager, CHOICES } from './src/serialManager.js';
import { Interpreter } from './src/interpreter.js';
import { Deframer, TimeBase, TIME_EVENT_KEY, Poller, buildPoll, BURST_CYCLE_MS } from './src/homebus.js';
import { LiveController } from './src/livecontrol.js';
import { buildOutput, buildOutputMulti } from './src/homebus.js';
import { COMMANDS, OPERATORS, FAMILIES, RANGES, SYNTAX, DST_KEYWORDS, SRC_FORMS, renderFromDecoded } from './src/instructionset.js';
import { decode as decodeRuleExact, encode as encodeRuleExact, compileText, compileLine } from './src/compiler.js';
import { buildModel, applyModel, decodeTrigger, triggerGroupId } from './src/model.js';
import { deriveEntities, mergeOverrides } from './src/entities.js';
import { Bridge } from './src/bridge.js';
import { HaMqtt } from './src/hamqtt.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// Persistent data directory. Inside the Home Assistant add-on this is /data,
// the only path that survives an add-on update.
const DATA_DIR = process.env.HEIMAUTO_DATA_DIR || join(here, 'data');
const DEFAULT_HRB = join(here, '..', 'RouleBase.hrb');
const DATA_HRB = join(DATA_DIR, 'RouleBase.hrb');
const LABELS_JSON = join(DATA_DIR, 'labels.json');
const ENTITIES_JSON = join(DATA_DIR, 'entities.json');
const BRIDGE_JSON = join(DATA_DIR, 'bridge-state.json');
try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }

// Friendly names layer: address token ("1A.0.0" / "1A.0" / "1A") -> human name.
// Editable in the UI, persisted to data/labels.json. Seeded with the few names
// the original parser source documents plus the live-verified HWR devices.
const LABELS_SEED = {
  'trigger:8': 'Zeit – jede Minute (Zeitschaltuhr)',
  '1A': 'Hauswirtschaftsraum (HWR)',
  '1A.0.0': 'HWR Licht (Relais)',
  '1A.0.6': 'HWR Taster',
  '41.0.5': 'Licht hinter Garage',
  '40.0.4': 'Licht unter Carport',
  '30.0.1': 'Zirkulationspumpe Warmwasser HWR unten',
};
function loadLabels() {
  try { if (existsSync(LABELS_JSON)) return JSON.parse(readFileSync(LABELS_JSON, 'utf8')); } catch { /* ignore */ }
  return { ...LABELS_SEED };
}
function saveLabels(map) {
  try {
    mkdirSync(dirname(LABELS_JSON), { recursive: true });
    writeFileSync(LABELS_JSON, JSON.stringify(map, null, 2));
    return true;
  } catch { return false; }
}
let labels = loadLabels();

// ---- in-memory application state ------------------------------------------
let rulebase = new RuleBase();
// Prefer the user's working copy (data/RouleBase.hrb, written by "Speichern");
// fall back to the pristine original (../RouleBase.hrb), which stays untouched
// as a reset source.
const HRB_LOAD = existsSync(DATA_HRB) ? DATA_HRB : DEFAULT_HRB;
if (existsSync(HRB_LOAD)) {
  try {
    rulebase = RuleBase.fromBuffer(readFileSync(HRB_LOAD));
    console.log('[hrb] loaded', HRB_LOAD, rulebase.summary());
  } catch (e) {
    console.warn('[hrb] could not load file:', e.message);
  }
}

const serial = new SerialManager();
let simulator = new Interpreter(rulebase);

// HomeBus protocol layer
const deframer = new Deframer(1024);
const timeBase = new TimeBase();
let timeBaseTimer = null;

// HomeBus is a polled master/slave bus — the PC must poll each module or it
// stays silent. The poller sends poll frames round-robin over the module list.
const poller = new Poller();
let discoveredModules = [];

// ---- Home Assistant bridge -------------------------------------------------
// Entity registry (derived from the rule base) + user overrides.
function readJson(path, fallback) {
  try { if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')); } catch { /* ignore */ }
  return fallback;
}
function writeJson(path, obj) {
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(obj, null, 2)); return true; }
  catch { return false; }
}

let entityOverrides = readJson(ENTITIES_JSON, { entities: {}, modules: {}, areas: {} });
let entities = [];

const bridge = new Bridge({ queueOutput: (M, sub, val) => {
  if (!poller.running) {
    // Without a running poller an output frame never reaches the wire (the
    // master only transmits inside its poll burst) — say so instead of
    // pretending the command was executed.
    const msg = `Ausgang ${M.toString(16)}.${sub} = 0x${val.toString(16)} verworfen: Polling läuft nicht`;
    console.warn('[bridge]', msg);
    broadcast({ type: 'ha-log', msg, t: Date.now() });
    return;
  }
  poller.queueOutput(M, sub, val);
  broadcast({ type: 'output', addr: M, sub, val, hex: poller.frameFor(M).frame.toString('hex'), auto: false });
} });
bridge.restore(readJson(BRIDGE_JSON, null));
const ha = new HaMqtt(bridge);
ha.onLog = (msg) => { console.log('[ha]', msg); broadcast({ type: 'ha-log', msg, t: Date.now() }); };

// mode 'bridge' = Home Assistant orchestrates, the .hrb rule base does NOT run.
// mode 'rules'  = faithful original behaviour (rule base drives the outputs).
// mode 'both'   = transition mode: rules run AND entities are reported to HA.
// Default 'rules' keeps the standalone webapp behaving exactly as before; the
// Home Assistant add-on sets HEIMAUTO_MODE=bridge in its options.
let haMode = ['bridge', 'rules', 'both'].includes(process.env.HEIMAUTO_MODE)
  ? process.env.HEIMAUTO_MODE : 'rules';

function rebuildEntities() {
  entities = mergeOverrides(deriveEntities(rulebase, { labels, modules: discoveredModules }), entityOverrides);
  bridge.setEntities(entities);
  ha.setEntities(entities, entityOverrides);
  publishSystem();
  return entities;
}

// Diagnostics of the bridge itself (bus polling, module count, mode).
function publishSystem() {
  ha.publishSystem({ polling: poller.running, modules: discoveredModules.length, mode: haMode });
}

let bridgeSaveTimer = null;
bridge.onState = (entity, state) => {
  ha.publishState(entity, state);
  broadcast({ type: 'entity-state', id: entity.id, state });
  if (bridgeSaveTimer) return;
  bridgeSaveTimer = setTimeout(() => { bridgeSaveTimer = null; writeJson(BRIDGE_JSON, bridge.snapshot()); }, 2000);
};

// Live master automaton (Methode 3): poll responses -> rules -> computed outputs
const live = new LiveController(simulator);
live.onInput = (M, sub, prev, val) => bridge.noteInput(M, sub, prev, val);
live.onAutomat = (evt) => broadcast({ type: 'automat', t: Date.now(), ...evt });
// Rule output -> real bus frame. Faithful pulse: send the output once (a few
// cycles for reliability), then revert the module to scan-poll; the module
// latches the relay level.
live.onOutput = (M, sub, val) => {
  if (!poller.running) return;
  // Queue the column: several columns of the same module (e.g. the dimmer's
  // level byte 11.3 and command byte 11.4) are merged into ONE segment.
  poller.queueOutput(M, sub, val);
  broadcast({ type: 'output', addr: M, sub, val,
              hex: poller.frameFor(M).frame.toString('hex'), auto: true });
};

// Two different time-driven paths, deliberately separated:
//   * TIMER MAINTENANCE (ST/LT countdown + expiry events) is REACTIVE — it
//     finishes what the user just started, e.g. the shutter runs for the
//     configured LST time after a short tap. Always on with the live automaton.
//   * SCHEDULE rules (minute event key 8, 140 rules) switch the plant on their
//     own (shutters at 9:30, outdoor light at 23:00). Opt-in via
//     /api/automat { timebase: true }.
const TICK_MS = 250;   // SystemTimer cadence: ST every 2nd tick (0.5 s), LT every 240 (1 min)
let liveSchedule = false;
function deliverChanges(fired, source) {
  if (!live.running || !poller.running || !fired?.length) return [];
  const S = simulator.state;
  const finals = new Map();
  for (const f of fired) {
    for (const c of f.changes) {
      finals.set(((c.module & 0xff) << 4) | (c.sub & 0x0f),
                 { module: c.module & 0xff, sub: c.sub & 0x0f });
    }
  }
  const out = [];
  for (const { module, sub } of finals.values()) {
    if (module === 0x00) continue;                       // relative context mirror
    if (!discoveredModules.includes(module)) continue;    // not on this bus
    const value = S.getSubByte(module, sub) & 0xff;
    out.push({ module, sub, value });
    live.onOutput(module, sub, value);
  }
  if (out.length) broadcast({ type: 'automat', t: Date.now(), source, module: 0, sub: 0, bit: 0,
                              rising: true, inputHex: '-', eventKey: TIME_EVENT_KEY,
                              ran: fired.length, outputs: out });
  return out;
}

// ---- HTTP / REST -----------------------------------------------------------
const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '16mb' }));
app.use(express.static(join(here, 'public')));

// --- metadata ---
app.get('/api/opcodes', (req, res) => {
  res.json({
    opcodes: OPCODES.map((label, index) => ({
      index,
      label,
      reserved: RESERVED.has(index),
      class: label ? opcodeClass(index) : null,
    })),
    serialChoices: CHOICES,
  });
});

// Authoritative instruction set recovered from ParserV1000.exe.
app.get('/api/instructionset', (req, res) => {
  res.json({ commands: COMMANDS, operators: OPERATORS, families: FAMILIES,
             ranges: RANGES, syntax: SYNTAX, dstKeywords: DST_KEYWORDS, srcForms: SRC_FORMS });
});

// Full rule base rendered as parser source text (like RBCmdExp).
app.get('/api/rulebase/source', (req, res) => {
  const lines = [];
  for (const run of rulebase.commandRuns()) {
    lines.push(`// --- Event-Key ${run.entry.groupId} (Offset ${run.entry.cmdOffset}) ---`);
    for (const w of run.rules) {
      const f = extractFields(w);
      lines.push('  ' + renderFromDecoded(decodeRuleExact(w)) + ';');
    }
  }
  res.type('text/plain').send(lines.join('\n') + '\n');
});

// Compile parser source text -> rule words (with per-line errors).
app.post('/api/rulebase/compile', (req, res) => {
  try {
    const { words, errors } = compileText(String(req.body?.source || ''));
    const out = words.map((w) => ({ line: w.line, hex: '0x' + w.word.toString(16).toUpperCase().padStart(8, '0'),
                                    opcode: w.rule.opcode, family: w.rule.family }));
    if (req.body?.replace && errors.length === 0) {
      rulebase.commands = words.map((w) => w.word);
      simulator = new Interpreter(rulebase);
    }
    res.json({ ok: errors.length === 0, count: out.length, words: out, errors, replaced: Boolean(req.body?.replace && !errors.length) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- graphical automation model (WENN/DANN) ---
// Full editable model: every index-run decoded into an ordered chain of
// statements, grouped so the UI can render "Auslöser -> WENN -> DANN" cards.
app.get('/api/model', (req, res) => {
  res.json({ ...buildModel(rulebase), labels });
});

// Replace the whole rule base from an edited model. Compiles each statement
// line (parser syntax) byte-exact; on any error nothing is changed.
app.post('/api/model', (req, res) => {
  const draft = new RuleBase();
  const result = applyModel(draft, req.body?.model || req.body || {});
  if (!result.ok) return res.status(400).json({ ok: false, errors: result.errors });
  rulebase = draft;
  simulator = new Interpreter(rulebase);
  live.setInterpreter(simulator);
  rebuildEntities();
  let saved = false;
  if (req.body?.save) {
    try { mkdirSync(dirname(DATA_HRB), { recursive: true }); writeFileSync(DATA_HRB, rulebase.toBuffer(true)); saved = true; } catch { /* ignore */ }
  }
  res.json({ ok: true, counts: result.counts, summary: rulebase.summary(), saved });
});

// Validate/compile a single statement line without changing anything (live
// preview + inline error for the editor).
app.post('/api/model/checkline', (req, res) => {
  const text = String(req.body?.line || '').trim();
  if (!text) return res.json({ ok: true, empty: true });
  try {
    const r = compileLine(text);
    if (!r) return res.json({ ok: true, empty: true });
    const word = encodeRuleExact(r) >>> 0;
    const isAssign = [':=', '~=', '&=', '|=', '^=', '+=', '-='].some((o) => text.replace(/\s/g, '').includes(o)) || /:=[01]$/.test(text.replace(/\s/g, ''));
    res.json({ ok: true, hex: '0x' + word.toString(16).toUpperCase().padStart(8, '0'), family: r.family, role: isAssign ? 'action' : 'condition' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Friendly names layer.
app.get('/api/labels', (req, res) => res.json({ labels }));
app.put('/api/labels', (req, res) => {
  const incoming = req.body?.labels;
  if (incoming && typeof incoming === 'object') {
    labels = {};
    for (const [k, v] of Object.entries(incoming)) {
      const name = String(v || '').trim();
      if (name) labels[k] = name;
    }
    saveLabels(labels);
    rebuildEntities();
  }
  res.json({ ok: true, labels });
});

// --- rule base ---
app.get('/api/rulebase', (req, res) => {
  res.json({
    summary: rulebase.summary(),
    index: rulebase.index,
    runs: rulebase.commandRuns().map((r) => ({
      groupId: r.entry.groupId,
      cmdOffset: r.entry.cmdOffset,
      start: r.start,
      end: r.end,
      count: r.rules.length,
    })),
  });
});

app.get('/api/rulebase/rules', (req, res) => {
  const rules = rulebase.commands.map((w, i) => {
    const d = decodeRule(w);
    const fields = extractFields(w);
    const cls = classifyExact(w);
    const dec = decodeRuleExact(w);
    return { i, ...d, fields, canonical: canonicalFields(w), exact: cls, decoded: dec,
             opcode: dec.opcode, family: dec.family,
             source: renderFromDecoded(dec), describe: describeExact(w) };
  });
  res.json({ count: rules.length, rules });
});

app.put('/api/rulebase/rules/:i', (req, res) => {
  const i = Number(req.params.i);
  if (!Number.isInteger(i) || i < 0 || i >= rulebase.commands.length) {
    return res.status(404).json({ error: 'rule index out of range' });
  }
  let word;
  if (typeof req.body.raw === 'number') word = req.body.raw >>> 0;
  else if (req.body.canonical) word = packCanonical(req.body.canonical);
  else word = encodeRule(req.body);
  rulebase.commands[i] = word;
  res.json({ i, raw: word, canonical: canonicalFields(word), exact: classifyExact(word) });
});

app.post('/api/rulebase/rules', (req, res) => {
  const word = typeof req.body.raw === 'number' ? req.body.raw >>> 0 : encodeRule(req.body);
  rulebase.commands.push(word);
  res.json({ i: rulebase.commands.length - 1, raw: word, ...decodeRule(word) });
});

app.delete('/api/rulebase/rules/:i', (req, res) => {
  const i = Number(req.params.i);
  if (!Number.isInteger(i) || i < 0 || i >= rulebase.commands.length) {
    return res.status(404).json({ error: 'rule index out of range' });
  }
  rulebase.commands.splice(i, 1);
  res.json({ ok: true, count: rulebase.commands.length });
});

// import (upload raw .hrb) / export (download)
app.post('/api/rulebase/import', (req, res) => {
  try {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    rulebase = RuleBase.fromBuffer(buf);
    simulator = new Interpreter(rulebase);
    live.setInterpreter(simulator);
    rebuildEntities();
    res.json({ ok: true, summary: rulebase.summary() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/rulebase/export', (req, res) => {
  const rebuild = req.query.rebuild === '1';
  const buf = rulebase.toBuffer(rebuild);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="RouleBase.hrb"');
  res.send(buf);
});

app.post('/api/rulebase/save', (req, res) => {
  try {
    const buf = rulebase.toBuffer(req.body && req.body.rebuild);
    writeFileSync(DATA_HRB, buf);
    res.json({ ok: true, path: DATA_HRB, bytes: buf.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- serial ---
app.get('/api/serial/ports', async (req, res) => {
  res.json({ ports: await SerialManager.list(), status: serial.status() });
});

app.get('/api/serial/status', (req, res) => res.json(serial.status()));

app.post('/api/serial/open', async (req, res) => {
  try {
    const status = await serial.open(req.body || {});
    broadcast({ type: 'serial-status', status });
    res.json(status);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/serial/close', async (req, res) => {
  poller.stop();
  await serial.close();
  broadcast({ type: 'serial-status', status: serial.status() });
  res.json(serial.status());
});

app.post('/api/serial/send', async (req, res) => {
  try {
    const hex = String(req.body.hex || '').replace(/[^0-9a-fA-F]/g, '');
    if (hex.length % 2) throw new Error('hex string must have an even number of nibbles');
    const buf = Buffer.from(hex, 'hex');
    await serial.write(buf);
    res.json({ ok: true, bytes: buf.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- simulator (faithful RBExecCmd interpreter) ---
app.get('/api/sim/state', (req, res) => res.json(simulator.state.snapshot()));

app.post('/api/sim/register', (req, res) => {
  const addr = Number(req.body?.addr) & 0xff;
  const slot = simulator.state.register(addr);
  broadcast({ type: 'sim-state', state: simulator.state.snapshot() });
  res.json({ ok: true, addr, slot });
});

app.post('/api/sim/run', (req, res) => {
  const passes = Math.min(Number(req.body?.passes) || 1, 1000);
  const results = [];
  for (let p = 0; p < passes; p++) results.push(simulator.runAll());
  broadcast({ type: 'sim-state', state: simulator.state.snapshot() });
  res.json({ passes, results });
});

// Inject an input change and let the rule engine propagate it (condition chain).
app.post('/api/sim/inject', (req, res) => {
  const { mod, sub, value } = req.body || {};
  const r = simulator.inject(Number(mod), Number(sub), Number(value));
  broadcast({ type: 'sim-state', state: simulator.state.snapshot() });
  res.json({ ok: true, ...r });
});

// Set / clear a single bit of a module sub-address, then evaluate.
app.post('/api/sim/setbit', (req, res) => {
  const { mod, sub, bit, value } = req.body || {};
  simulator.state.register(Number(mod) & 0xff);
  simulator.state.setBit(Number(mod), Number(sub), Number(bit), Number(value) ? 1 : 0);
  simulator.state.drainChanges();
  simulator.processModule(Number(mod) & 0xff);
  broadcast({ type: 'sim-state', state: simulator.state.snapshot() });
  res.json({ ok: true });
});

app.post('/api/sim/reset', (req, res) => {
  simulator = new Interpreter(rulebase);
  broadcast({ type: 'sim-state', state: simulator.state.snapshot() });
  res.json({ ok: true });
});

// --- HomeBus output (Ausgang an ein Modul senden) ---
// Setzt/löscht einen Announced-Poll-Override im Poller: das Modul wird dann mit
// dem Ausgangs-Frame statt dem Scan-Poll bedient (Ausgang in der Sequenz).
app.post('/api/bus/output', (req, res) => {
  const addr = Number(req.body?.addr) & 0xff;
  if (req.body?.clear) { poller.setOverride(addr, null); return res.json({ ok: true, cleared: true }); }
  // Either one column {sub,val} or several {cols:[{sub,val},...]} in ONE segment.
  const cols = Array.isArray(req.body?.cols) && req.body.cols.length
    ? req.body.cols.map((c) => ({ sub: Number(c.sub) & 0x0f, val: Number(c.val) & 0xff }))
    : [{ sub: Number(req.body?.sub) & 0x0f, val: Number(req.body?.val) & 0xff }];
  if (req.body?.queue) {
    for (const c of cols) poller.queueOutput(addr, c.sub, c.val);
    const f = poller.frameFor(addr).frame;
    return res.json({ ok: true, addr, cols, hex: f.toString('hex'), queued: true });
  }
  const frame = buildOutputMulti(addr, cols);
  poller.setOverride(addr, frame);
  broadcast({ type: 'output', addr, cols, hex: frame.toString('hex') });
  res.json({ ok: true, addr, cols, hex: frame.toString('hex') });
});

// --- HomeBus polling (master) ---
// One-shot discovery: poll every address once, collect which ones answer.
app.post('/api/bus/discover', async (req, res) => {
  if (!serial.isOpen || serial.status().mock) {
    return res.status(400).json({ error: 'Kein echter serieller Port offen' });
  }
  const start = Number(req.body?.start ?? 0x00) & 0xff;
  const end = Number(req.body?.end ?? 0xff) & 0xff;
  const waitMs = Math.max(10, Number(req.body?.waitMs) || 25);
  const answered = new Map();
  const onRx = (buf) => { if (curAddr !== null) answered.set(curAddr, (answered.get(curAddr) || Buffer.alloc(0))); const prev = answered.get(curAddr); answered.set(curAddr, Buffer.concat([prev, buf])); };
  let curAddr = null;
  serial.on('rx', onRx);
  try {
    for (let m = start; m <= end; m++) {
      curAddr = m;
      answered.set(m, Buffer.alloc(0));
      await serial.write(buildPoll(m));
      await new Promise((r) => setTimeout(r, waitMs));
      if (answered.get(m).length === 0) answered.delete(m);
    }
  } finally {
    serial.off('rx', onRx);
    curAddr = null;
  }
  discoveredModules = [...answered.keys()].sort((a, b) => a - b);
  live.setModules(discoveredModules);
  rebuildEntities();
  const list = discoveredModules.map((m) => ({ addr: m, hex: '0x' + m.toString(16).toUpperCase().padStart(2, '0'), reply: answered.get(m).toString('hex') }));
  broadcast({ type: 'discover', modules: list });
  res.json({ ok: true, count: list.length, modules: list });
});

// Start/stop the round-robin poller (drives the live monitoring).
app.post('/api/bus/poll', (req, res) => {
  const run = Boolean(req.body?.run);
  poller.stop();
  if (!run) return res.json({ ok: true, status: poller.status() });
  if (!serial.isOpen) return res.status(400).json({ error: 'Kein Port offen' });
  const addrs = Array.isArray(req.body?.addrs) && req.body.addrs.length
    ? req.body.addrs.map((x) => Number(x) & 0xff)
    : (discoveredModules.length ? discoveredModules : null);
  // Burst mode = original behaviour: all modules in ONE write per cycle every
  // ~110 ms, so a switch is seen (and an output delivered) within ~0.1 s instead
  // of a 1.25 s round-robin lap. 'roundrobin' stays available for diagnostics.
  const mode = req.body?.mode === 'roundrobin' ? 'roundrobin' : 'burst';
  const intervalMs = Number(req.body?.intervalMs) || (mode === 'burst' ? BURST_CYCLE_MS : 50);
  poller.onPoll = (addr) => broadcast({ type: 'poll', addr });
  poller.start((frame) => serial.write(frame), addrs, intervalMs, { mode });
  publishSystem();
  broadcast({ type: 'poll-status', status: poller.status() });
  res.json({ ok: true, status: poller.status() });
});

app.get('/api/bus/poll', (req, res) => res.json({ status: poller.status(), discovered: discoveredModules }));

// --- Live-Automat (Eingang -> Regel -> berechneter Ausgang) ---
app.post('/api/automat', (req, res) => {
  const run = Boolean(req.body?.run);
  live.setInterpreter(simulator);
  live.setModules(discoveredModules);
  live.rules = haMode !== 'bridge';
  if (haMode !== 'rules') bridge.start();
  if (run) live.start(Number(req.body?.windowMs) || 80);
  else live.stop();
  // SystemTimer runs whenever the automaton runs (timers must count down for
  // shutters/light timeouts). The checkbox only enables the SCHEDULE rules.
  liveSchedule = Boolean(run && req.body?.timebase);
  if (timeBaseTimer) { clearInterval(timeBaseTimer); timeBaseTimer = null; }
  if (run) timeBaseTimer = setInterval(doTick, TICK_MS);
  broadcast({ type: 'automat-status', running: live.running, timebase: liveSchedule });
  res.json({ ok: true, running: live.running, timebase: liveSchedule, timers: Boolean(timeBaseTimer), modules: discoveredModules.length });
});
app.get('/api/automat', (req, res) => res.json({ running: live.running, modules: discoveredModules }));

// --- HomeBus protocol / time base ---
app.get('/api/bus/status', (req, res) => {
  res.json({
    deframer: deframer.stats(),
    timeBase: { running: Boolean(timeBaseTimer), counter: timeBase.counter, lastMinute: timeBase.lastMinute },
    dateTime: timeBase.dateTime(),
  });
});

app.post('/api/bus/deframer/limit', (req, res) => {
  deframer.setLimit(Number(req.body?.limit));
  res.json({ ok: true, stats: deframer.stats() });
});

// One time-base tick (SystemTimer equivalent): ShortTimer/LongTimer maintenance
// and, on a minute change, event key 8 pushed into the rule queue.
function doTick() {
  const ev = timeBase.tick();
  simulator.state.dt = timeBase.dateTime();
  // Reactive timer maintenance — always. An expiring timer fires the event key
  // that equals its id (e.g. 0xC89 = "Rolladen stoppen").
  if (ev.shortTimer) deliverChanges(simulator.tickShortTimers?.(), 'ST-Timer');
  if (ev.longTimer) deliverChanges(simulator.tickLongTimers?.(), 'LT-Timer');
  const keys = timeBase.drainQueue();
  for (const key of keys) {
    if (!liveSchedule) continue;             // scheduled switching is opt-in
    // processEventKey derives the relative-addressing base from the key
    // ((key>>7)&0xff = 0 for the time key), which processModule(key) got wrong.
    deliverChanges(simulator.processEventKey(key), 'zeit');
  }
  if (ev.minuteChanged || ev.longTimer) {
    broadcast({ type: 'sim-state', state: simulator.state.snapshot() });
  }
  broadcast({ type: 'tick', events: ev, keys, dateTime: simulator.state.dt });
  return { events: ev, keys };
}

app.post('/api/bus/tick', (req, res) => res.json(doTick()));

app.post('/api/bus/timebase', (req, res) => {
  const run = Boolean(req.body?.run);
  const intervalMs = Math.max(100, Number(req.body?.intervalMs) || 1000);
  if (timeBaseTimer) { clearInterval(timeBaseTimer); timeBaseTimer = null; }
  if (run) timeBaseTimer = setInterval(doTick, intervalMs);
  res.json({ ok: true, running: Boolean(timeBaseTimer), intervalMs });
});


// ---- Home Assistant: Entitäten, MQTT, Betriebsart ---------------------------

// The derived entity registry (what gets reported to Home Assistant).
app.get('/api/entities', (req, res) => {
  res.json({
    mode: haMode,
    count: entities.length,
    enabled: entities.filter((e) => e.enabled !== false).length,
    entities: entities.map((e) => ({ ...e, state: bridge.stateOf(e) })),
    overrides: entityOverrides,
    mqtt: ha.status(),
  });
});

// Save the user's overrides (name / kind / area / travel time / enabled) and
// re-publish discovery. Body: { entities: {id: {...}}, modules: {...}, areas: {...} }
app.put('/api/entities', (req, res) => {
  const body = req.body || {};
  entityOverrides = {
    entities: body.entities && typeof body.entities === 'object' ? body.entities : (entityOverrides.entities || {}),
    modules: body.modules && typeof body.modules === 'object' ? body.modules : (entityOverrides.modules || {}),
    areas: body.areas && typeof body.areas === 'object' ? body.areas : (entityOverrides.areas || {}),
  };
  writeJson(ENTITIES_JSON, entityOverrides);
  rebuildEntities();
  if (ha.connected) { ha.publishDiscovery(); bridge.publishAll(); }
  broadcast({ type: 'entities', count: entities.length });
  res.json({ ok: true, count: entities.length, enabled: entities.filter((e) => e.enabled !== false).length });
});

// Drive one entity by hand (the UI's test buttons take this path, exactly like
// a Home Assistant command would).
app.post('/api/entities/:id/command', (req, res) => {
  try {
    const state = bridge.command(req.params.id, req.body?.cmd ?? req.body ?? {});
    res.json({ ok: true, id: req.params.id, state });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/ha', (req, res) => {
  res.json({ mode: haMode, rules: live.rules, mqtt: ha.status(),
             bridge: { running: bridge.running, outputs: Object.fromEntries(bridge.outputs) },
             entities: entities.length });
});

// Betriebsart: 'bridge' (HA orchestriert, Regelbasis läuft NICHT),
// 'rules' (originalgetreu), 'both' (Übergang: beides).
app.post('/api/ha/mode', (req, res) => {
  const mode = ['bridge', 'rules', 'both'].includes(req.body?.mode) ? req.body.mode : 'bridge';
  haMode = mode;
  live.rules = mode !== 'bridge';
  if (mode === 'rules') bridge.stop(); else bridge.start();
  publishSystem();
  broadcast({ type: 'ha-mode', mode: haMode, rules: live.rules });
  res.json({ ok: true, mode: haMode, rules: live.rules });
});

app.post('/api/ha/mqtt', async (req, res) => {
  try {
    if (req.body?.connect === false) { await ha.disconnect(); return res.json({ ok: true, mqtt: ha.status() }); }
    rebuildEntities();
    const status = await ha.connect({
      host: req.body?.host, port: req.body?.port,
      username: req.body?.username, password: req.body?.password,
      base: req.body?.base, discoveryPrefix: req.body?.discoveryPrefix,
    });
    bridge.start();
    publishSystem();
    broadcast({ type: 'ha-mqtt', mqtt: status });
    res.json({ ok: true, mqtt: status });
  } catch (e) {
    res.status(400).json({ error: e.message, mqtt: ha.status() });
  }
});

// Re-send the whole discovery set (e.g. after renaming a lot of entities).
app.post('/api/ha/discovery', (req, res) => {
  const n = ha.publishDiscovery();
  publishSystem();
  bridge.publishAll();
  res.json({ ok: true, published: n });
});

// ---- WebSocket -------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', serial: serial.status(), rulebase: rulebase.summary() }));
});

// pipe serial events to all clients; RX additionally goes through the HomeBus
// deframer so the monitor can show synchronised frames, not just raw bytes.
serial.on('rx', (buf) => {
  broadcast({ type: 'rx', hex: buf.toString('hex'), t: Date.now() });
  try { live.feed(buf); } catch (e) { /* non-fatal */ }
  let frames = [];
  try {
    frames = deframer.push(buf);
  } catch (e) {
    broadcast({ type: 'serial-error', msg: 'deframer: ' + e.message });
  }
  for (const f of frames) {
    broadcast({
      type: 'frame',
      t: Date.now(),
      hex: f.hex,
      checksum: f.checksum,
      checksumOk: f.checksumOk,
      classes: f.classes.map((c) => c.cls).join(''),
      flagErrors: f.flagErrors.length,
      partial: f.partial,
    });
  }
  if (frames.length) broadcast({ type: 'deframer-stats', stats: deframer.stats() });
});
serial.on('tx', (buf) => broadcast({ type: 'tx', hex: buf.toString('hex'), t: Date.now() }));
serial.on('serial-error', (msg) => broadcast({ type: 'serial-error', msg }));
serial.on('open', (status) => broadcast({ type: 'serial-status', status }));
serial.on('close', () => broadcast({ type: 'serial-status', status: serial.status() }));

// ---- Autostart (Home-Assistant-Add-on) ------------------------------------
// In the add-on nobody clicks buttons: the whole chain (port -> module scan ->
// polling -> bridge -> MQTT) has to come up on its own. Every step is optional
// and logged, so a missing broker or a missing USB adapter does not stop the
// web UI from running.
async function autostart() {
  const env = process.env;
  const wantSerial = env.HEIMAUTO_SERIAL_PATH;
  const wantMqtt = env.HEIMAUTO_MQTT_HOST;
  live.rules = haMode !== 'bridge';
  rebuildEntities();
  if (haMode !== 'rules') bridge.start();

  if (wantSerial) {
    try {
      await serial.open({ path: wantSerial, baudRate: Number(env.HEIMAUTO_SERIAL_BAUD) || 115200 });
      console.log('[autostart] serieller Port offen:', wantSerial);
      const start = Number(env.HEIMAUTO_SCAN_START ?? 0x10);
      const end = Number(env.HEIMAUTO_SCAN_END ?? 0x4f);
      const found = [];
      let cur = null;
      const onRx = () => { if (cur !== null && !found.includes(cur)) found.push(cur); };
      serial.on('rx', onRx);
      for (let m = start; m <= end; m++) {
        cur = m;
        await serial.write(buildPoll(m));
        await new Promise((r) => setTimeout(r, 25));
      }
      serial.off('rx', onRx);
      cur = null;
      discoveredModules = found.sort((a, b) => a - b);
      live.setModules(discoveredModules);
      rebuildEntities();
      console.log('[autostart] Module gefunden:', discoveredModules.map((m) => m.toString(16)).join(' '));
      poller.onPoll = (addr) => broadcast({ type: 'poll', addr });
      poller.start((frame) => serial.write(frame), discoveredModules, BURST_CYCLE_MS, { mode: 'burst' });
      live.start(80);
      if (haMode !== 'bridge') timeBaseTimer = timeBaseTimer || setInterval(doTick, TICK_MS);
      console.log('[autostart] Polling + Live-Automat laufen, Betriebsart:', haMode);
    } catch (e) {
      console.warn('[autostart] serieller Port konnte nicht geöffnet werden:', e.message);
    }
  }

  if (wantMqtt) {
    try {
      await ha.connect({
        host: env.HEIMAUTO_MQTT_HOST,
        port: env.HEIMAUTO_MQTT_PORT,
        username: env.HEIMAUTO_MQTT_USER || undefined,
        password: env.HEIMAUTO_MQTT_PASS || undefined,
        base: env.HEIMAUTO_MQTT_BASE || 'heimauto',
        discoveryPrefix: env.HEIMAUTO_MQTT_PREFIX || 'homeassistant',
      });
      publishSystem();
      console.log('[autostart] MQTT verbunden,', entities.filter((e) => e.enabled !== false).length, 'Entitäten gemeldet');
    } catch (e) {
      console.warn('[autostart] MQTT nicht verbunden:', e.message);
    }
  }
}

server.listen(PORT, () => {
  console.log(`RouleEditor Web running at http://localhost:${PORT}`);
  console.log(`serialport native module: ${serial.status().serialportAvailable ? 'available' : 'MOCK only'}`);
  autostart().catch((e) => console.warn('[autostart]', e.message));
});

process.on('SIGTERM', async () => {
  try { poller.stop(); live.stop(); bridge.stop(); writeJson(BRIDGE_JSON, bridge.snapshot()); await ha.disconnect(); await serial.close(); } catch { /* ignore */ }
  process.exit(0);
});
