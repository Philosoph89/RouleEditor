// Live-Zuordnung: welcher Taster ist das gerade?
//
// Das Problem, das dieses Modul löst: die Anlage hat über 150 Ein- und Ausgänge,
// die im Original nur als Adresse (Modul.Sub.Bit) existieren. Wer eine Anlage
// übernimmt, weiß nicht, welcher Schalter an der Wand welche Adresse hat. Die
// einzige verlässliche Zuordnung ist: drücken und schauen, was hereinkommt.
//
// Zu jedem eingehenden Bitwechsel wird deshalb alles zusammengetragen, was über
// diese Adresse bekannt ist:
//   * der Klarname (labels.json) und die zugehörige Entität der Registry,
//   * der Event-Key, den das Original daraus bildet,
//   * die Regelketten der Original-Konfiguration an diesem Event-Key —
//     im Klartext, mit WENN/DANN getrennt,
//   * die Ausgänge, die diese Ketten anfassen, aufgelöst auf ihre Entitäten.
//
// Damit steht in der Karte nicht nur "1A.0.6 wurde gedrückt", sondern
// "das ist der Taster, der im Original das HWR-Licht umschaltet".

import { decode } from './compiler.js';
import { renderFromDecoded } from './instructionset.js';
import { isAssignment, operatorOf } from './entities.js';
import { SUB_ROLES } from './moduleinfo.js';

const hx2 = (n) => (n & 0xff).toString(16).toUpperCase().padStart(2, '0');

export const eventKeyOf = (module, sub, bit) =>
  (((module & 0xff) << 7) | ((((sub & 0x0f) * 8) + (bit & 7)) & 0x7f)) & 0xffff;

// Index: Event-Key -> Ketten. Einmal pro Regelbasis gebaut, damit die Auswertung
// je Tastendruck ein Map-Zugriff ist und kein Scan über 578 Läufe.
export function buildIndex(rulebase) {
  const byKey = new Map();
  rulebase.commandRuns().forEach((run, i) => {
    const key = run.entry.groupId;
    const statements = run.rules.map((w) => {
      const d = decode(w >>> 0);
      const action = isAssignment(d);
      return {
        source: renderFromDecoded(d),
        role: action ? 'action' : 'condition',
        operator: operatorOf(d),
        // Ziel nur bei Aktionen; Modul 0x00 heißt "das auslösende Modul"
        target: action && d.dstMod !== undefined
          ? { module: d.dstMod, sub: d.dstSub, bit: d.dstBit, relative: d.dstMod === 0x00 }
          : null,
      };
    });
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ run: i, statements });
  });
  return byKey;
}

// Entität, die einen Ausgang (Modul, Sub, Bit) bedient.
export function entityForOutput(entities, module, sub, bit) {
  for (const e of entities) {
    if (e.module !== module) continue;
    if (e.kind === 'cover') {
      if (e.sub === sub && (e.bitDir === bit || e.bitRun === bit)) return e;
    } else if (e.kind === 'dimmer') {
      if (sub === e.levelSub || sub === e.cmdSub) return e;
      if (sub === 0 && bit !== undefined && e.stateBit === bit) return e;
    } else if (e.kind === 'level' || e.kind === 'fan') {
      // Stufenregister: ein Byte, kein Bit — deshalb auch ohne Bit-Angabe treffen
      if (e.sub === sub) return e;
    } else if (e.kind === 'switch' || e.kind === 'light') {
      if (e.sub === sub && e.bit === bit) return e;
    }
  }
  return null;
}

export function entityForInput(entities, module, sub, bit) {
  return entities.find((e) => e.kind === 'button' && e.module === module
                              && e.sub === sub && e.bit === bit) || null;
}

const brief = (e) => (e ? { id: e.id, name: e.name, kind: e.kind, area: e.area || null,
                            enabled: e.enabled !== false } : null);

// Alles, was über eine Eingangsadresse bekannt ist.
// index = Rückgabe von buildIndex(), entities = die Registry, labels = labels.json
export function identifyInput({ module, sub, bit, value, prev }, { index, entities, labels = {} }) {
  const token = `${hx2(module)}.${sub}.${bit}`;
  const eventKey = eventKeyOf(module, sub, bit);
  const chains = (index.get(eventKey) || []).map((c) => ({
    run: c.run,
    when: c.statements.filter((s) => s.role === 'condition').map((s) => s.source),
    then: c.statements.filter((s) => s.role === 'action').map((s) => s.source),
  }));

  // Ausgänge dieser Ketten, aufgelöst auf Entitäten (relative Adresse 00 = dieses Modul)
  const outMap = new Map();
  for (const c of index.get(eventKey) || []) {
    for (const s of c.statements) {
      if (!s.target) continue;
      const M = s.target.relative ? module : s.target.module;
      const ent = entityForOutput(entities, M, s.target.sub, s.target.bit);
      const k = ent ? ent.id : `${hx2(M)}.${s.target.sub}.${s.target.bit ?? '-'}`;
      if (!outMap.has(k)) {
        outMap.set(k, { token: `${hx2(M)}.${s.target.sub}${s.target.bit === undefined ? '' : '.' + s.target.bit}`,
                        module: M, sub: s.target.sub, bit: s.target.bit,
                        relative: s.target.relative, entity: brief(ent),
                        label: labels[`${hx2(M)}.${s.target.sub}.${s.target.bit}`] || null });
      }
    }
  }

  const entity = entityForInput(entities, module, sub, bit);
  return {
    token, module, sub, bit,
    // Für Eingänge, die in der Regelbasis NICHT als Auslöser vorkommen, gibt es
    // keine abgeleitete Entität — die Zuordnungskarte kann daraus auf Wunsch
    // eine anlegen (siehe POST /api/identify/label mit create:true).
    suggestedId: `input_${hx2(module).toLowerCase()}_${sub}_${bit}`,
    hexAddr: '0x' + hx2(module),
    value, prev,
    pressed: value !== undefined && bit !== undefined ? Boolean(value & (1 << bit)) : null,
    eventKey, eventKeyHex: '0x' + eventKey.toString(16).toUpperCase(),
    label: labels[token] || null,
    entity: brief(entity),
    known: Boolean(entity || labels[token]),
    chains,
    outputs: [...outMap.values()],
  };
}

// Dieselbe Auflösung für die Ausgänge eines wirklich gelaufenen Regeldurchlaufs.
// Ein Ausgang ist dort ein GANZES Sub-Byte (so geht es über den Bus), also
// können mehrere Entitäten daran hängen — jede mit ihrem Bit-Zustand.
// Welche Bits eines Ausgangsbytes fassen die Ketten dieses Event-Keys überhaupt
// an? Ohne diese Maske würde ein Byte-Ausgang ALLE Geräte des Bytes melden —
// beim Dimmertaster erschien so die Jalousie desselben Moduls als "Stopp",
// obwohl die Regel nur Bit 5 angefasst hat. Welche der Ketten wirklich gelaufen
// ist, ist hier nicht bekannt; die Vereinigung ihrer Ziele ist die genaueste
// Aussage, die ohne Mitschrift des Interpreters möglich ist.
export function touchedMask(index, eventKey, eventModule) {
  const map = new Map();
  for (const c of index.get(eventKey) || []) {
    for (const st of c.statements) {
      if (!st.target) continue;
      const M = st.target.relative ? eventModule : st.target.module;
      const k = `${hx2(M)}.${st.target.sub}`;
      const cur = map.get(k) || { bits: 0, whole: false };
      if (st.target.bit === undefined) cur.whole = true;      // Byte-Zuweisung
      else cur.bits |= 1 << st.target.bit;
      map.set(k, cur);
    }
  }
  return map;
}

export function entitiesForByte(entities, module, sub, value, touched = null) {
  const out = [];
  const hit = (mask) => !touched || (touched.whole || (touched.bits & mask) !== 0);
  for (const e of entities) {
    if (e.module !== module) continue;
    // Abgeschaltete Entitäten (Merker, Status-LEDs) würden die Karte zumüllen:
    // ein Lüftungs-Tastendruck schreibt acht LED-Bits auf 31.1 und stand vorher
    // als acht Zeilen "Schalter 31.1.x EIN/AUS" da. Sie werden unten als EINE
    // Zeile mit der Rolle des Sub-Bytes zusammengefasst.
    if (e.enabled === false) continue;
    if (e.kind === 'cover' && e.sub === sub) {
      if (!hit((1 << e.bitDir) | (1 << e.bitRun))) continue;
      const up = (value >> e.bitDir) & 1;
      const run = (value >> e.bitRun) & 1;
      out.push({ entity: brief(e), state: run ? (up ? 'fährt auf' : 'fährt zu') : 'Stopp', on: Boolean(run) });
    } else if ((e.kind === 'level' || e.kind === 'fan') && e.sub === sub) {
      if (!hit(0xff)) continue;
      const steps = e.steps || 1;
      const idx = Math.round((value - e.min) / (e.step || 1));
      out.push({ entity: brief(e), state: `Stufe ${idx} von ${steps - 1}`, on: idx > 0 });
    } else if (e.kind === 'dimmer' && (sub === e.levelSub || sub === e.cmdSub)) {
      if (!hit(0xff)) continue;
      const max = e.levelMax || 0x40;
      out.push({ entity: brief(e),
                 state: sub === e.levelSub ? `Pegel ${Math.round((value / max) * 100)} %` : `Kommando 0x${(value & 0xff).toString(16).toUpperCase()}`,
                 on: sub === e.levelSub ? value > 0 : null });
    } else if ((e.kind === 'switch' || e.kind === 'light') && e.sub === sub && e.bit !== undefined) {
      if (!hit(1 << e.bit)) continue;
      const on = Boolean((value >> e.bit) & 1);
      out.push({ entity: brief(e), state: on ? 'EIN' : 'AUS', on });
    }
  }
  // die gerade eingeschalteten zuerst — das ist meist das, was man sehen will
  return out.sort((a, b) => Number(b.on === true) - Number(a.on === true));
}

// touched = Rückgabe von touchedMask(); ohne sie werden alle Geräte des Bytes
// gemeldet (Aufrufe ohne Event-Kontext).
export function describeOutputs(outputs, { entities, labels = {}, touched = null }) {
  return (outputs || []).map((o) => {
    const key = `${hx2(o.module)}.${o.sub}`;
    const hits = entitiesForByte(entities, o.module, o.sub, o.value & 0xff, touched?.get(key) || null);
    return {
      token: `${hx2(o.module)}.${o.sub}`,
      module: o.module, sub: o.sub, value: o.value & 0xff,
      hex: '0x' + (o.value & 0xff).toString(16).toUpperCase().padStart(2, '0'),
      devices: hits,
      entity: hits[0]?.entity || null,
      state: hits[0]?.state || null,
      // Wenn keine gemeldete Entität an dem Byte hängt, sagt wenigstens die
      // Rolle des Sub-Bytes, was da passiert (Sub 1 = Status-LEDs der Taster).
      role: hits.length ? null : (SUB_ROLES[o.sub] || null),
      label: labels[`${hx2(o.module)}.${o.sub}`] || null,
    };
  });
}
