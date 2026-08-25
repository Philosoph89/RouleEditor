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
import { moduleInfo, moduleLabel, MODULE_TYPES } from './moduleinfo.js';
import { buildConnectionIndex, coverName, classifyInput, classifyOutput, areaFor } from './connections.js';

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

export function deriveEntities(rulebase, { labels = {}, modules = [], hardware = null,
                                           connections = null } = {}) {
  const known = new Set(modules.map((m) => m & 0xff));
  const cs = chains(rulebase);
  // Anschlussdokumentation der Anlage: liefert Klarnamen, Geräteklassen und
  // Räume für jede Klemme — und die Anschlüsse, die die alte Konfiguration nie
  // benutzt hat (die werden unten als eigene Entitäten ergänzt).
  const conn = connections === false ? null : buildConnectionIndex(connections || undefined);
  const doc = (token, dir) => (conn ? conn.byAddr.get(token)?.[dir] || null : null);
  // Name: eigener Klarname des Nutzers > Anschlussdokumentation > Platzhalter
  const named = (token, dir, fallback) => labels[token] || doc(token, dir)?.desc || fallback;

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
  // Die Anschlussliste korrigiert Fehltreffer: 15.0.2/15.0.3 werden von einer
  // Zentral-Kette gemeinsam gelöscht UND es läuft ein Timer mit — sie sind aber
  // laut Doku zwei Steckdosen ("Erkerfenster mitte", 16:30 ein / 22:30 aus).
  // Sagt die Dokumentation für eines der beiden Bits etwas anderes als
  // „Rolladen", ist es kein Rolladen.
  if (conn) {
    for (const k of [...covers.keys()]) {
      const [mh, ss, bs] = k.split('.');
      const b0 = conn.byAddr.get(`${mh}.${ss}.${bs}`)?.out;
      const b1 = conn.byAddr.get(`${mh}.${ss}.${Number(bs) + 1}`)?.out;
      const contradicts = (d) => d && classifyOutput(d.desc).kind !== 'cover';
      if (contradicts(b0) || contradicts(b1)) covers.delete(k);
    }
  }

  const coverBits = new Set();
  for (const k of covers.keys()) {
    const [m, s, b] = k.split('.');
    coverBits.add(`${m}.${s}.${b}`);
    coverBits.add(`${m}.${s}.${Number(b) + 1}`);
  }

  // 2b. Stufenschalter: ein Byte-Register, das um eine feste Schrittweite hoch-
  // und runtergezählt wird. Die Lüftung der Anlage ist genau das (belegt durch
  // die Original-Logs vom 2026-08-25, "Lüftung oben/unten 15x hoch/runter"):
  //     1C.0 < $FF ; 1C.0 += $11      (eine Stufe höher)
  //     1C.0 > $00 ; 1C.0 -= $11      (eine Stufe tiefer)
  //     1C.0 := $FF / := $00          (beide Tasten = Maximum / Aus)
  // 0x11 als Schrittweite ergibt 16 Stufen (0x00, 0x11, … 0xEE, 0xFF) — genau
  // die Werte, die im Log auf dem Bus stehen. Am Modul hängen Widerstandsreihen.
  const levels = new Map();          // "M.sub" -> { step, min, max, wrap }
  // Erster Durchgang: wo wird überhaupt schrittweise gezählt?
  for (const c of cs) {
    for (const st of c.stmts) {
      if (!isAssignment(st) || st.family !== 'BYTE_CONST') continue;
      if (!['+=', '-='].includes(operatorOf(st))) continue;
      const k = `${hx2(st.dstMod)}.${st.dstSub}`;
      const cur = levels.get(k) || { step: 0, min: 0, max: 0xff, wrap: false };
      cur.step = cur.step || (st.const8 & 0xff) || 1;
      levels.set(k, cur);
    }
  }
  // Zweiter Durchgang: Grenzen und Rundlauf. Getrennt, weil Wächter und Schritt
  // in VERSCHIEDENEN Ketten stehen können (bei 1C.7 tun sie das).
  for (const c of cs) {
    const guards = c.stmts.filter((d) => !isAssignment(d) && d.family === 'BYTE_CONST'
                                         && ['>', '>=', '<', '=<'].includes(operatorOf(d)));
    if (!guards.length) continue;
    const steps = c.stmts.filter((d) => isAssignment(d) && d.family === 'BYTE_CONST'
                                        && ['+=', '-='].includes(operatorOf(d)));
    const sets = c.stmts.filter((d) => isAssignment(d) && d.family === 'BYTE_CONST'
                                       && operatorOf(d) === ':=');
    for (const g of guards) {
      const k = `${hx2(g.dstMod)}.${g.dstSub}`;
      const cur = levels.get(k);
      if (!cur) continue;
      const op = operatorOf(g);
      const sameReg = (d) => d.dstMod === g.dstMod && d.dstSub === g.dstSub;
      if (steps.some(sameReg)) {
        // Wächter + Schritt in einer Kette = Bereichsgrenze:
        //   1C.0 > $00 ; 1C.0 -= $11     (nur runter, wenn über dem Minimum)
        //   1C.0 < $FF ; 1C.0 += $11     (nur hoch, wenn unter dem Maximum)
        if (op === '>' || op === '>=') cur.min = g.const8 & 0xff;
        if (op === '<' || op === '=<') cur.max = g.const8 & 0xff;
      } else {
        // Wächter + Konstanten-Zuweisung = Überlauf: "1C.7 > $07 ; 1C.7 := $00"
        // heißt 8 Stellungen mit Rundlauf — nicht "Minimum 7".
        const reset = sets.find(sameReg);
        if (!reset) continue;
        if (op === '>' || op === '>=') {
          cur.max = g.const8 & 0xff;
          cur.min = reset.const8 & 0xff;
          cur.wrap = true;
        }
      }
    }
  }

  // 2c. Stufenanzeige: Ketten der Form "<Register> == $XX ; <Bit-Zuweisungen>"
  // sind die LED-Muster je Stufe. Sie stehen byte-genau so im Original-Log
  // (Stufe 0x00 -> 31.1 = 0x30, 18.1 = 0x04, 19.1 = 0x04, Rest 0x00), also kann
  // die Bridge sie im HA-Betrieb selbst nachbilden — sonst zeigen die
  // Taster-LEDs an der Wand die falsche Stufe.
  const indicators = new Map();      // "M.sub" -> { value -> [{module, sub, set, clr}] }
  const indicatorConflicts = [];     // Abweichungen zwischen den Bedien-Tastern
  const variants = new Map();        // "reg|value" -> Map<signature, {table, triggers}>
  for (const c of cs) {
    const first = c.stmts[0];
    if (!first || isAssignment(first) || first.family !== 'BYTE_CONST') continue;
    if (operatorOf(first) !== '==') continue;
    const reg = `${hx2(first.dstMod)}.${first.dstSub}`;
    if (!levels.has(reg)) continue;
    const bits = c.stmts.slice(1).filter((d) => isAssignment(d) && d.family === 'BIT_CONST');
    if (!bits.length || bits.length !== c.stmts.length - 1) continue;
    const byByte = new Map();
    for (const b of bits) {
      const k = `${hx2(b.dstMod)}.${b.dstSub}`;
      const e = byByte.get(k) || { module: b.dstMod, sub: b.dstSub, set: 0, clr: 0 };
      if (assignedBitValue(b) === 1) e.set |= 1 << b.dstBit; else e.clr |= 1 << b.dstBit;
      byByte.set(k, e);
    }
    const table = [...byByte.values()].sort((a, b) => (a.module - b.module) || (a.sub - b.sub));
    const sig = table.map((t) => `${t.module}.${t.sub}:${t.set}/${t.clr}`).join(',');
    const vkey = `${reg}|${first.const8}`;
    if (!variants.has(vkey)) variants.set(vkey, new Map());
    const v = variants.get(vkey);
    const hit = v.get(sig) || { table, triggers: [] };
    hit.triggers.push(c.groupId);
    v.set(sig, hit);
  }
  // Jede Stufe steht viermal in der Regelbasis — einmal je Bedien-Taster. Sie
  // sollten identisch sein, sind es aber NICHT: der Taster 0x1880 („Lüftung
  // Flur OG niedriger") schreibt bei Stufe 0x22 und 0x00 ein falsches
  // LED-Muster (0x70 statt 0xF0 bzw. 0x30). Im Original-Log ist genau das zu
  // sehen — beim Runterfahren bleibt die Anzeige stehen. Wir übernehmen deshalb
  // die Mehrheitsvariante (3 von 4) und melden die Abweichung.
  for (const [vkey, v] of variants) {
    const [reg, valStr] = vkey.split('|');
    const value = Number(valStr);
    const ranked = [...v.values()].sort((a, b) => b.triggers.length - a.triggers.length);
    if (!indicators.has(reg)) indicators.set(reg, {});
    indicators.get(reg)[value] = ranked[0].table;
    for (const odd of ranked.slice(1)) {
      indicatorConflicts.push({
        register: reg, value,
        majority: ranked[0].triggers.map((g) => '0x' + g.toString(16).toUpperCase()),
        deviating: odd.triggers.map((g) => '0x' + g.toString(16).toUpperCase()),
        expected: ranked[0].table.map((t) => `${hx2(t.module)}.${t.sub}:+${hx2(t.set)}/-${hx2(t.clr)}`),
        found: odd.table.map((t) => `${hx2(t.module)}.${t.sub}:+${hx2(t.set)}/-${hx2(t.clr)}`),
      });
    }
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
  // Raum: aus dem Beschreibungstext des Anschlusses. Steht dort kein Raum, wird
  // der EINBAUORT des Moduls als Vermutung genommen — er stimmt oft, aber nicht
  // immer (Modul 10 sitzt im Gästezimmer, schaltet auch Speisekammer und Küche).
  const areaOfDesc = (desc, module) => {
    const a = areaFor(desc || '');
    if (a) return { area: a, guess: false };
    const room = conn?.rooms?.[hx2(module)];
    const g = room ? areaFor(room) : null;
    return g ? { area: g, guess: true } : { area: null, guess: false };
  };

  for (const [key, cov] of [...covers].sort()) {
    const [mh, ss, bs] = key.split('.');
    const M = parseInt(mh, 16), sub = Number(ss), bitDir = Number(bs), bitRun = bitDir + 1;
    out.push({
      id: `cover_${mh.toLowerCase()}_${sub}_${bitDir}`,
      kind: 'cover', module: M, sub, bitDir, bitRun,
      travelSec: cov.travelSec || 30,
      timers: [...cov.timers],
      name: labels[`${mh}.${sub}.${bitDir}`] || labels[`cover:${mh}.${sub}.${bitDir}`]
            || (conn && coverName(conn, M, sub, bitDir, bitRun))
            || `Jalousie ${mh}.${sub}.${bitDir}`,
      connector: doc(`${mh}.${sub}.${bitDir}`, 'out')?.connector || null,
      sheet: doc(`${mh}.${sub}.${bitDir}`, 'out')?.desc || null,
      ...(({ area, guess }) => ({ area, areaGuess: guess || undefined }))(
        areaOfDesc(doc(`${mh}.${sub}.${bitDir}`, 'out')?.desc, M)),
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
      name: labels[`${mh}.dim`] || labels[`${mh}.${DIM_LEVEL_SUB}`]
            || cleanDesc(conn?.dimmers.get(mh)?.desc) || `Dimmer ${mh}`,
      connector: conn?.dimmers.get(mh)?.connector || null,
      sheet: conn?.dimmers.get(mh)?.desc || null,
      ...(({ area, guess }) => ({ area, areaGuess: guess || undefined }))(
        areaOfDesc(conn?.dimmers.get(mh)?.desc, M)),
      online: known.size === 0 || known.has(M),
      source: 'derived',
    });
  }

  for (const [key, lv] of [...levels].sort()) {
    const [mh, ss] = key.split('.');
    const M = parseInt(mh, 16), sub = Number(ss);
    const step = lv.step || 1;
    const steps = Math.floor((lv.max - lv.min) / step) + 1;
    if (steps < 2 || steps > 64) continue;   // ein Zähler ist kein Stufenschalter
    const name = labels[key] || `Stufenschalter ${key}`;
    // Ein Stufenregister, das nach Lüftung klingt, wird in Home Assistant ein
    // fan (Prozent-Slider); alles andere ein number (0..n).
    const isFan = /l[üu]ftung|ventilat|abluft|zuluft|fan|gebl[äa]se/i.test(name);
    out.push({
      id: `level_${mh.toLowerCase()}_${sub}`,
      kind: isFan ? 'fan' : 'level',
      module: M, sub,
      step, min: lv.min, max: lv.max, steps, wrap: Boolean(lv.wrap),
      indicators: indicators.get(key) || null,
      indicatorConflicts: indicatorConflicts.filter((c) => c.register === key),
      name,
      online: known.size === 0 || known.has(M),
      source: 'derived',
    });
  }

  // Dimmer-Hardware, die die alte Konfiguration nicht nutzt: als Vorschlag
  // anlegen (abgeschaltet), damit man sie in Home Assistant dazuholen kann.
  for (const [key, info] of Object.entries({ ...MODULE_TYPES, ...(hardware || {}) })) {
    if (info.type !== 'Dimmer') continue;
    const M = parseInt(key, 16);
    if (dimmers.has(M)) continue;
    out.push({
      id: `light_${key.toLowerCase()}_dim`,
      kind: 'dimmer', module: M,
      levelSub: DIM_LEVEL_SUB, cmdSub: DIM_CMD_SUB, levelMax: DIM_LEVEL_MAX,
      stateBit: null,
      name: label(`${key}.dim`) || `Dimmer ${key} (unbenutzt)`,
      online: known.size === 0 || known.has(M),
      hardwareOnly: true, enabled: false,
      source: 'hardware',
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
    // Sub 1 sind die Status-LEDs der Taster (durch die Anschlussliste belegt),
    // Sub 7 die Merker der Regelbasis.
    const d = doc(key, sub === 1 ? 'led' : 'out');
    const name = labels[key] || cleanDesc(d?.desc);
    const cls = d && sub !== 1 ? classifyOutput(d.desc) : {};
    const isLight = cls.kind === 'light'
      || /licht|lampe|leuchte|strahler|spot|beleucht/i.test(name || '');
    const kind = isLight ? 'light' : 'switch';
    out.push({
      id: `${kind}_${mh.toLowerCase()}_${sub}_${bit}`,
      kind,
      module: M, sub, bit, count,
      name: name || `${sub === 1 ? 'Status-LED' : isLight ? 'Licht' : 'Schalter'} ${key}`,
      deviceClass: cls.deviceClass || undefined,
      connector: d?.connector || null,
      sheet: d?.desc || null,
      ...(({ area, guess }) => ({ area, areaGuess: guess || undefined }))(areaOfDesc(d?.desc, M)),
      undocumented: d ? undefined : true,
      online: known.size === 0 || known.has(M),
      internal: flag,                 // rule-base flag bit / Status-LED
      statusLed: sub === 1 || undefined,
      source: 'derived',
    });
  }

  for (const [key, count] of [...inputs].sort()) {
    const [mh, ss, bs] = key.split('.');
    const M = parseInt(mh, 16), sub = Number(ss), bit = Number(bs);
    const d = doc(key, 'in');
    const cls = d ? classifyInput(d.desc) : {};
    out.push({
      id: `input_${mh.toLowerCase()}_${sub}_${bit}`,
      kind: 'button', module: M, sub, bit, count,
      name: labels[key] || cleanDesc(d?.desc) || `Taster ${key}`,
      deviceClass: cls.deviceClass || undefined,
      connector: d?.connector || null,
      sheet: d?.desc || null,
      ...(({ area, guess }) => ({ area, areaGuess: guess || undefined }))(areaOfDesc(d?.desc, M)),
      undocumented: d ? undefined : true,
      online: known.size === 0 || known.has(M),
      source: 'derived',
    });
  }

  // --- Anschlüsse, die die Regelbasis nie benutzt -----------------------------
  // Die Anschlussliste dokumentiert deutlich mehr als die alte Konfiguration
  // schaltet: drei Flurlichter auf Modul 1A, ein Dutzend Steckdosen und vor
  // allem die Sensorik (Fensterkontakte, Rauchmelder, Sonnenfühler,
  // Sabotagekontakte). Genau das will man in Home Assistant haben.
  if (conn) {
    const has = new Set(out.map((e) => e.id));
    // Bytes, die einem Stufenregister gehören (die 8 Lüfterrelais von 1C), und
    // die Lüftermotor-Ansteuerung dürfen nicht als Einzelschalter erscheinen.
    const levelBytes = new Set(out.filter((e) => e.kind === 'level' || e.kind === 'fan')
                                  .map((e) => `${hx2(e.module)}.${e.sub}`));
    for (const [token, dirs] of conn.byAddr) {
      const [mh, ss, bs] = token.split('.');
      const M = parseInt(mh, 16), sub = Number(ss), bit = Number(bs);
      const area = (desc) => (({ area, guess }) => ({ area, areaGuess: guess || undefined }))(areaOfDesc(desc, M));

      const o = dirs.out;
      if (o && !levelBytes.has(`${mh}.${sub}`)) {
        const cls = classifyOutput(o.desc);
        // "Rolladen" ohne Regelbasis-Paar: einzelnes Relais, kein Cover — ohne
        // Laufzeit aus der Regelbasis wäre eine Positionsschätzung geraten.
        const kind = cls.kind === 'cover' ? 'switch' : cls.kind;
        const id = `${kind}_${mh.toLowerCase()}_${sub}_${bit}`;
        if (!has.has(id) && !has.has(`switch_${mh.toLowerCase()}_${sub}_${bit}`)
            && !has.has(`light_${mh.toLowerCase()}_${sub}_${bit}`)) {
          out.push({
            id, kind, module: M, sub, bit,
            name: labels[token] || cleanDesc(o.desc),
            deviceClass: cls.deviceClass || undefined,
            connector: o.connector, sheet: o.desc, ...area(o.desc),
            // Verkabelungsnotizen und die Lüftermotor-Relais werden angelegt,
            // aber nicht ungefragt gemeldet.
            enabled: !(o.wiring || o.fanDrive),
            wiring: o.wiring || undefined, fanDrive: o.fanDrive || undefined,
            unusedByRules: true,
            online: known.size === 0 || known.has(M),
            source: 'sheet',
          });
          has.add(id);
        }
      }

      const i = dirs.in;
      if (i) {
        const id = `input_${mh.toLowerCase()}_${sub}_${bit}`;
        if (!has.has(id)) {
          const cls = classifyInput(i.desc);
          out.push({
            id, kind: 'button', module: M, sub, bit,
            name: labels[token] || cleanDesc(i.desc),
            deviceClass: cls.deviceClass || undefined,
            connector: i.connector, sheet: i.desc, ...area(i.desc),
            enabled: true, unusedByRules: true,
            online: known.size === 0 || known.has(M),
            source: 'sheet',
          });
          has.add(id);
        }
      }

      const l = dirs.led;
      if (l) {
        const id = `switch_${mh.toLowerCase()}_${sub}_${bit}`;
        if (!has.has(id)) {
          out.push({
            id, kind: 'switch', module: M, sub, bit,
            name: labels[token] || cleanDesc(l.desc),
            connector: l.connector, sheet: l.desc, ...area(l.desc),
            internal: true, statusLed: true, enabled: false, unusedByRules: true,
            online: known.size === 0 || known.has(M),
            source: 'sheet',
          });
          has.add(id);
        }
      }
    }
  }

  return out;
}

// Merge derived entities with the user's overrides (data/entities.json).
// An override may change name/kind/area/deviceClass/travelSec/enabled and may
// add entities that the rule base does not mention.
const KIND_NAME = { cover: 'Jalousie', dimmer: 'Dimmer', light: 'Licht', switch: 'Schalter',
                    button: 'Taster', fan: 'Lüftung', level: 'Stufenschalter' };

// Die Dokumentation schreibt Markierungen wie "[Dimmer]" oder Kabelnotizen mit
// in den Text; für einen Entitätsnamen wird das gekürzt.
export function cleanDesc(desc) {
  if (!desc) return null;
  let s = String(desc)
    .replace(/\s*\[Dimmer\]\s*/gi, ' ')
    .replace(/^Dimmausgang\s+/i, '')
    .replace(/^Dimmer\s+/i, '')
    .replace(/^Rolladenausgang\s+/i, 'Rolladen ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 80) s = s.slice(0, 77).replace(/\s\S*$/, '') + '…';
  return s || null;
}

export function mergeOverrides(derived, overrides = {}, { labels = {} } = {}) {
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
    // Von Hand angelegte Entitäten (Adressen, die in der Regelbasis nicht
    // vorkommen) haben keinen abgeleiteten Namen: Klarname aus der Label-Schicht
    // ziehen, sonst einen sprechenden Platzhalter — ein Name ist Pflicht, sonst
    // steht in Home Assistant eine leere Entität.
    if (!e.name) {
      const token = e.bit === undefined ? `${hx2(e.module)}.${e.sub}` : `${hx2(e.module)}.${e.sub}.${e.bit}`;
      e.name = labels[token] || `${KIND_NAME[e.kind] || 'Gerät'} ${token}`;
    }
  }
  return list.sort((a, b) => (a.module - b.module) || a.id.localeCompare(b.id));
}

function areaOf(e, overrides) {
  const mh = hx2(e.module);
  return (overrides.areas && overrides.areas[mh]) || null;
}

// areaHint wird nur gesetzt, wenn ALLE gemeldeten Entitäten des Moduls im
// selben Raum sitzen. MQTT-Discovery kennt `suggested_area` nur am Gerät, und
// ein Modul schaltet oft in mehrere Räume (Modul 11: Rolladen Speisekammer,
// Dimmer Küche) — dann gewinnt sonst willkürlich die zuletzt gesendete Entität.
export function areaHints(entities) {
  const byModule = new Map();
  for (const e of entities) {
    if (e.enabled === false) continue;
    const k = hx2(e.module);
    const cur = byModule.get(k);
    if (cur === undefined) byModule.set(k, e.area || null);
    else if (cur !== (e.area || null)) byModule.set(k, false);   // mehrdeutig
  }
  const out = {};
  for (const [k, v] of byModule) if (v) out[k] = v;
  return out;
}

export function moduleDevice(module, overrides = {}, areaHint = null) {
  const mh = hx2(module);
  const info = moduleInfo(module, overrides.hardware || {});
  return {
    identifiers: [`heimauto_mod_${mh.toLowerCase()}`],
    name: (overrides.modules && overrides.modules[mh]) || moduleLabel(module, overrides.hardware || {}),
    manufacturer: 'HomeBus (Thomas Manthey)',
    // Typ und Version melden die Module selbst (SignaturString); die Liste
    // stammt aus dem ModulListe-Tab des Originals, siehe src/moduleinfo.js.
    model: info ? `HomeBus-${info.type} ${info.version}` : 'HomeBus I/O-Modul',
    sw_version: info?.date || undefined,
    suggested_area: areaHint || undefined,
    via_device: 'heimauto_master',
  };
}

export const hexAddr = hx2;
