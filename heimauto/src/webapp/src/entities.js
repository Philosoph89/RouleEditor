// Entity registry: derives the physical devices of the HomeBus plant from the
// rule base, so they can be published to Home Assistant over MQTT.
//
// WHY the rule base is the source of truth: the modules themselves are dumb
// I/O — a poll reply only reports the INPUT byte, it says nothing about what a
// module's output bits are wired to. The rule base, however, encodes exactly
// that: every actuator appears as an assignment destination, and the way it is
// assigned identifies the device class:
//
//   cover   two ADJACENT bits of one sub-byte assigned in ONE chain together
//           with a timer load, e.g.
//              19.0.0 := 0 ; 19.0.1 := 1 ; LST9 := 30.0     (drive down 30 s)
//              19.0.0 := 1 ; 19.0.1 := 1 ; LST9 := 6.0      (drive up 6 s)
//              19.0.1 := 0 ; 19.0.0 := 0                    (stop)
//           => even bit = direction (1 = up/open), odd bit = motor run,
//              travel time = the largest timer preset seen (full travel).
//   light   (dimmable) a module driven with the two-byte dimmer protocol:
//              M.3 := $00..$40   level        M.4 := $30  apply level
//              M.4 := $17 ramp up   $15 ramp down   $10 stop ramp
//           The sub-0 bit toggled in the same chain is the channel's on/off
//           memory and is folded into the light entity instead of becoming a
//           switch of its own.
//   switch  every other assigned bit of sub 0 (relay contacts).
//   button  the physical inputs: every event key of the index whose sub-address
//           is 0 or >= 2 (sub 1 holds the timer-expiry events, not inputs).
//
// Sub 1 and sub 7 assignments are the rule base's own flag/scratch bits
// (e.g. 10.7.0 "shutter already driven today", 31.1.x scene flags). They are
// not physical outputs and stay out of the registry unless the user enables
// them explicitly.

import { decode } from './compiler.js';
import { OPERATORS } from './instructionset.js';

const hx2 = (n) => (n & 0xff).toString(16).toUpperCase().padStart(2, '0');

// Dimmer command byte values (verified across all 14 dimmer modules).
export const DIM = { RAMP_UP: 0x17, RAMP_DOWN: 0x15, STOP: 0x10, APPLY: 0x30 };
export const DIM_LEVEL_SUB = 3;   // level byte
export const DIM_CMD_SUB = 4;     // command byte
export const DIM_LEVEL_MAX = 0x40;

// Sub-addresses that carry physical I/O. 1 and 7 are rule-base flags.
const PHYSICAL_SUBS = new Set([0]);
const FLAG_SUBS = new Set([1, 7]);

// --- statement helpers ------------------------------------------------------

// Operator index within a family group: 0..5 = comparisons, 8..14 = assignments.
function withinOf(d) {
  if (d.opcode <= 3) return d.opcode <= 1 ? d.opcode : d.opcode + 6;   // != == := ~=
  if (d.opcode <= 7) return d.opcode <= 5 ? d.opcode - 4 : d.opcode + 2; // ==0 ==1 :=0 :=1
  return (d.opcode - 8) % 16;
}
export function isAssignment(d) { return withinOf(d) >= 8; }
export function operatorOf(d) {
  const w = withinOf(d);
  return OPERATORS[w <= 5 ? w : w - 2] || '?';
}

// Assigned constant of a bit assignment, or null for :=/~= from another bit.
function assignedBitValue(d) {
  if (d.family === 'BIT_CONST') return d.opcode === 6 ? 0 : d.opcode === 7 ? 1 : null;
  return null;   // BIT_BIT := / ~= (copy / toggle)
}

// Timer preset in seconds. ST/LST count in 0.5 s steps, LT/LLT in minutes.
function timerSeconds(d) {
  if (d.family === 'ST' || d.family === 'LST') return d.time / 2;
  return d.time * 60;
}

// Decode every index run into a chain of decoded statements.
export function chains(rulebase) {
  return rulebase.commandRuns().map((run) => ({
    groupId: run.entry.groupId,
    stmts: run.rules.map((w) => decode(w >>> 0)),
  }));
}

// --- derivation -------------------------------------------------------------

export function deriveEntities(rulebase, { labels = {}, modules = [] } = {}) {
  const known = new Set(modules.map((m) => m & 0xff));
  const cs = chains(rulebase);

  // 1. dimmer channels: a module addressed with the command byte M.4
  const dimmers = new Map();          // module -> { stateBits:Set, presets:Set }
  for (const c of cs) {
    const cmds = c.stmts.filter((d) => isAssignment(d) && d.family === 'BYTE_CONST'
      && d.dstSub === DIM_CMD_SUB
      && [DIM.RAMP_UP, DIM.RAMP_DOWN, DIM.STOP, DIM.APPLY].includes(d.const8));
    if (!cmds.length) continue;
    for (const cmd of cmds) {
      const M = cmd.dstMod;
      if (!dimmers.has(M)) dimmers.set(M, { stateBits: new Set() });
      // the on/off memory bit of this channel: a sub-0 bit touched in the same chain
      for (const d of c.stmts) {
        if (isAssignment(d) && (d.family === 'BIT_CONST' || d.family === 'BIT_BIT')
            && d.dstMod === M && d.dstSub === 0) {
          dimmers.get(M).stateBits.add(d.dstBit);
        }
      }
    }
  }

  // 2. covers: adjacent bit pairs assigned in one chain, with a timer load
  const covers = new Map();           // "M.sub.evenBit" -> { travelSec }
  for (const c of cs) {
    const bitAsg = c.stmts.filter((d) => isAssignment(d)
      && (d.family === 'BIT_CONST' || d.family === 'BIT_BIT'));
    if (bitAsg.length < 2) continue;
    const loads = c.stmts.filter((d) => isAssignment(d)
      && ['ST', 'LST', 'LT', 'LLT'].includes(d.family));
    for (const a of bitAsg) {
      for (const b of bitAsg) {
        if (a.dstMod !== b.dstMod || a.dstSub !== b.dstSub) continue;
        if (!(a.dstBit % 2 === 0 && b.dstBit === a.dstBit + 1)) continue;
        // sub 1 / sub 7 hold the rule base's own flag bits (e.g. 10.7.0/10.7.1
        // "shutter already driven today") — adjacent flag pairs are not covers.
        if (FLAG_SUBS.has(a.dstSub)) continue;
        const key = `${hx2(a.dstMod)}.${a.dstSub}.${a.dstBit}`;
        const cur = covers.get(key) || { travelSec: 0, timers: new Set(), stopOnly: true };
        // a chain that starts the motor (run bit := 1) carries the run time
        if (assignedBitValue(b) === 1 && loads.length) {
          cur.stopOnly = false;
          for (const l of loads) {
            cur.travelSec = Math.max(cur.travelSec, timerSeconds(l));
            cur.timers.add(`${l.family}${l.hi}`);
          }
        }
        covers.set(key, cur);
      }
    }
  }
  // pairs that only ever appear in stop chains are not covers
  for (const [k, v] of [...covers]) if (v.stopOnly) covers.delete(k);

  const coverBits = new Set();
  for (const k of covers.keys()) {
    const [m, s, b] = k.split('.');
    coverBits.add(`${m}.${s}.${b}`);
    coverBits.add(`${m}.${s}.${Number(b) + 1}`);
  }

  // 3. every assigned bit (for switches) and the flag bits (excluded by default)
  const assignedBits = new Map();     // "M.sub.bit" -> count
  for (const c of cs) {
    for (const d of c.stmts) {
      if (!isAssignment(d)) continue;
      if (d.family !== 'BIT_CONST' && d.family !== 'BIT_BIT') continue;
      const k = `${hx2(d.dstMod)}.${d.dstSub}.${d.dstBit}`;
      assignedBits.set(k, (assignedBits.get(k) || 0) + 1);
    }
  }

  // 4. inputs: the index' event keys. sub 1 = timer-expiry events, not inputs.
  const inputs = new Map();           // "M.sub.bit" -> count
  for (const c of cs) {
    const g = c.groupId;
    const M = (g >> 7) & 0xff;
    const ev = g & 0x7f;
    const sub = (ev >> 3) & 0x0f;
    const bit = ev & 7;
    if (M === 0x00) continue;                 // time / relative context keys
    if (sub === 1) continue;                  // timer expiry ("Ablaufevent")
    const k = `${hx2(M)}.${sub}.${bit}`;
    inputs.set(k, (inputs.get(k) || 0) + 1);
  }

  // --- build the entity list ---
  const out = [];
  const label = (...keys) => { for (const k of keys) if (labels[k]) return labels[k]; return null; };

  for (const [key, cov] of [...covers].sort()) {
    const [mh, ss, bs] = key.split('.');
    const M = parseInt(mh, 16), sub = Number(ss), bitDir = Number(bs), bitRun = bitDir + 1;
    out.push({
      id: `cover_${mh.toLowerCase()}_${sub}_${bitDir}`,
      kind: 'cover', module: M, sub, bitDir, bitRun,
      travelSec: cov.travelSec || 30,
      timers: [...cov.timers],
      name: label(`${mh}.${sub}.${bitDir}`, `cover:${mh}.${sub}.${bitDir}`)
            || `Jalousie ${mh}.${sub}.${bitDir}`,
      deviceClass: 'shutter',
      online: known.size === 0 || known.has(M),
      source: 'derived',
    });
  }

  for (const [M, dim] of [...dimmers].sort((a, b) => a[0] - b[0])) {
    const mh = hx2(M);
    // The channel's on/off memory bit is folded into the light entity — unless
    // the user has explicitly named that bit, which means it is a device of its
    // own (e.g. 41.0.5 "Licht hinter Garage" on a module that also dims).
    const folded = [...dim.stateBits].filter((b) => !labels[`${mh}.0.${b}`]);
    const stateBit = folded[0];
    dim.folded = new Set(folded);
    out.push({
      id: `light_${mh.toLowerCase()}_dim`,
      kind: 'dimmer', module: M,
      levelSub: DIM_LEVEL_SUB, cmdSub: DIM_CMD_SUB, levelMax: DIM_LEVEL_MAX,
      stateBit: stateBit === undefined ? null : stateBit,
      name: label(`${mh}.dim`, `${mh}.${DIM_LEVEL_SUB}`) || `Dimmer ${mh}`,
      online: known.size === 0 || known.has(M),
      source: 'derived',
    });
  }

  for (const [key, count] of [...assignedBits].sort()) {
    const [mh, ss, bs] = key.split('.');
    const M = parseInt(mh, 16), sub = Number(ss), bit = Number(bs);
    if (M === 0x00) continue;
    if (coverBits.has(key)) continue;                       // part of a cover
    const dim = dimmers.get(M);
    if (dim && sub === 0 && dim.folded?.has(bit)) continue;   // dimmer state bit
    const flag = FLAG_SUBS.has(sub) || !PHYSICAL_SUBS.has(sub);
    const name = label(key);
    const isLight = /licht|lampe|leuchte|strahler|spot|beleucht/i.test(name || '');
    out.push({
      id: `${isLight ? 'light' : 'switch'}_${mh.toLowerCase()}_${sub}_${bit}`,
      kind: isLight ? 'light' : 'switch',
      module: M, sub, bit, count,
      name: name || `${isLight ? 'Licht' : 'Schalter'} ${key}`,
      online: known.size === 0 || known.has(M),
      internal: flag,                 // rule-base flag bit, not a physical output
      source: 'derived',
    });
  }

  for (const [key, count] of [...inputs].sort()) {
    const [mh, ss, bs] = key.split('.');
    const M = parseInt(mh, 16), sub = Number(ss), bit = Number(bs);
    out.push({
      id: `input_${mh.toLowerCase()}_${sub}_${bit}`,
      kind: 'button', module: M, sub, bit, count,
      name: label(key) || `Taster ${key}`,
      online: known.size === 0 || known.has(M),
      source: 'derived',
    });
  }

  return out;
}

// Merge derived entities with the user's overrides (data/entities.json).
// An override may change name/kind/area/deviceClass/travelSec/enabled and may
// add entities that the rule base does not mention.
export function mergeOverrides(derived, overrides = {}) {
  const byId = new Map(derived.map((e) => [e.id, { ...e }]));
  for (const [id, ov] of Object.entries(overrides.entities || {})) {
    const base = byId.get(id) || { id, source: 'manual' };
    byId.set(id, { ...base, ...ov, id });
  }
  const list = [...byId.values()];
  // default enablement: physical devices yes, rule-base flag bits no
  for (const e of list) {
    if (e.enabled === undefined) e.enabled = !e.internal;
    e.area = e.area || areaOf(e, overrides);
  }
  return list.sort((a, b) => (a.module - b.module) || a.id.localeCompare(b.id));
}

function areaOf(e, overrides) {
  const mh = hx2(e.module);
  return (overrides.areas && overrides.areas[mh]) || null;
}

export function moduleDevice(module, overrides = {}) {
  const mh = hx2(module);
  return {
    identifiers: [`heimauto_mod_${mh.toLowerCase()}`],
    name: (overrides.modules && overrides.modules[mh]) || `HomeBus Modul ${mh}`,
    manufacturer: 'HomeBus',
    model: 'HomeBus I/O-Modul',
    via_device: 'heimauto_master',
  };
}

export const hexAddr = hx2;
