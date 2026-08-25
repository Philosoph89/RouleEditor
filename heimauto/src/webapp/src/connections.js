// Anschlussdokumentation → Busadressen, Klarnamen, Geräteklassen, Räume.
//
// Die Rohdaten (src/connections.data.js) sind aus den beiden Tabellen des
// Nutzers generiert und beschreiben jede Klemme der Anlage. Dieses Modul
// rechnet Klemmennummern in Busadressen um und leitet daraus ab, was ein
// Anschluss IST (Licht, Steckdose, Rauchmelder, Fensterkontakt …) und WO er
// sitzt (Raum aus dem Beschreibungstext).
//
// ZUORDNUNG KLEMME → ADRESSE (gegen die Regelbasis und Live-Messungen geprüft,
// siehe test/connections.test.js):
//
//   A x/n   Ausgang     -> Sub 0, Bit n      · "Dimmer" im Text -> Dimmerkanal
//   S x/n   Status-LED  -> Sub 1, Bit n
//   E x/n   Eingang     -> n<=7: Sub 0, Bit n · n>=8: Sub 2, Bit n-8
//
// Belege:
//   * A1A/0 = "HWR Deckenlampe" — genau das Relais, das live mit
//     `E5 1A 00 01 01` geschaltet wurde; E1A/6 = "HWR Lichtschalter" ist der
//     Taster, dessen Auslöser 0xD06 (1A.0.6) das Relais umschaltet.
//   * S31/0…S31/7 = "1.…8. LED von links Lüftungsanzeige Flur oben" — genau die
//     acht Bits 31.1.0…31.1.7, die die Stufen-LED-Tabelle der Lüftung schreibt.
//     Ebenso S10/2, S11/2, S13/2, S15/2, S18/2, S19/2, S1B/0, S1B/2 = die
//     "1.…8. Ausgang Anzeige Lüftung im Wohnzimmer".
//   * E10/10 und E10/11 = zweiter Rolladentaster Gästezimmer "an Tür auf/zu" —
//     die Regelbasis hat dort die Auslöser 10.2.2 und 10.2.3. Ebenso E30/9 und
//     E30/11 -> 30.2.1 / 30.2.3.

import { CONNECTIONS } from './connections.data.js';

const hx2 = (n) => (n & 0xff).toString(16).toUpperCase().padStart(2, '0');

// Platzhalter der Dokumentation, die kein Gerät bezeichnen.
// Nur die generischen Einträge sind Platzhalter — "Ausgang für
// Lüftermotoransteuerung" ist einer, "Ausgang" allein nicht. Ohne die Anker am
// Ende verschwanden die acht Lüfterrelais von Modul 1B aus der Liste.
const PLACEHOLDER = /^(\*+\s*frei\s*\*+|frei|nicht belegt|ausgang|eingang|signalausgang|-)$/i;
// Anschlüsse, die nur Verkabelung dokumentieren — daraus wird kein Schalter.
const WIRING = /(^|\b)(kabel|zusatzkabel|stromkabel|busleitung|versorgungsleitung|spannungsversorgung|strom aus|anschluß fernseher|anschluss fernseher|12 ?v)/i;
// Der Lüftermotor wird als Stufenregister gefahren, nicht als Einzelrelais.
const FAN_DRIVE = /lüftermotoransteuerung/i;

export function isPlaceholder(desc) {
  return !desc || PLACEHOLDER.test(desc.trim());
}

// Klemme -> Adresse. Rückgabe {sub, bit} oder {dimmer:true}.
export function connectorAddress(kind, n, desc = '') {
  if (kind === 'A') {
    if (/dimmer/i.test(desc)) return { dimmer: true };
    return { sub: 0, bit: n };
  }
  if (kind === 'S') return { sub: 1, bit: n };
  if (kind === 'E') return n <= 7 ? { sub: 0, bit: n } : { sub: 2, bit: n - 8 };
  return null;
}

// Räume aus dem Beschreibungstext. Nur eindeutige Treffer werden übernommen —
// der Einbauort des Moduls ist NICHT der Raum des Verbrauchers (Modul 10 steckt
// im Gästezimmer, schaltet aber auch Speisekammer und Küche).
const AREAS = [
  [/gästezimmer|gastezimmer/i, 'Gästezimmer'],
  [/speisekammer/i, 'Speisekammer'],
  [/gästeklo|gasteklo/i, 'Gästeklo'],
  [/kinderzimmer links/i, 'Kinderzimmer links'],
  [/kinderzimmer rechts/i, 'Kinderzimmer rechts'],
  [/kinderzimmer/i, 'Kinderzimmer'],
  [/arbeitszimmer/i, 'Arbeitszimmer'],
  [/schlafzimmer/i, 'Schlafzimmer'],
  [/\bbad\b|badewanne|dusche|spiegelschrank/i, 'Bad'],
  [/abstellraum/i, 'Abstellraum'],
  [/\bhwr\b|hauswirtschaft/i, 'Hauswirtschaftsraum'],
  [/küche|kuche|eßecke|essecke|speisek/i, 'Küche'],
  [/wohnzimmer|\bwz\b|erker|sitzecke|kamin/i, 'Wohnzimmer'],
  [/terrasse/i, 'Terrasse'],
  [/carport|garage|garagentor|zisterne|brunnen|einfahrt/i, 'Garage & Außen'],
  [/haustür|haustur|\bhat\b|garderobe|flur|treppe/i, 'Flur'],
  [/gaube/i, 'Dachgaube'],
];
export function areaFor(desc) {
  if (!desc) return null;
  const hits = AREAS.filter(([re]) => re.test(desc));
  return hits.length ? hits[0][1] : null;
}

// Was IST der Anschluss? Bestimmt die Home-Assistant-Geräteklasse.
const OUT_KINDS = [
  [/steckdose|pallisadensteckdose/i, { kind: 'switch', deviceClass: 'outlet' }],
  [/lampe|licht|neon|halogen|leuchte|strahler|beleucht/i, { kind: 'light' }],
  [/heizung|heizkörper|heizkorper/i, { kind: 'switch' }],
  [/pumpe|zirkulation/i, { kind: 'switch' }],
  [/rolladen|jalousie|rollade/i, { kind: 'cover' }],
  [/\btor\b|garagentor/i, { kind: 'switch' }],
];
const IN_KINDS = [
  [/rauchmelder/i, { deviceClass: 'smoke' }],
  [/bewegungsmelder/i, { deviceClass: 'motion' }],
  [/sabotage/i, { deviceClass: 'tamper' }],
  [/read ?kontakt|readkontakt|\bread\b/i, { deviceClass: 'opening' }],
  [/sonnenfühler|sonnenfuhler|sonnenfühl/i, { deviceClass: 'light' }],
  [/füllstand|fullstand/i, { deviceClass: null }],
  [/paniktaster/i, { deviceClass: 'safety' }],
];

export function classifyOutput(desc) {
  for (const [re, v] of OUT_KINDS) if (re.test(desc)) return v;
  return { kind: 'switch' };
}
export function classifyInput(desc) {
  for (const [re, v] of IN_KINDS) if (re.test(desc)) return v;
  return { deviceClass: null };
}

// Index: "MM.S.B" -> { out, in, led }  (drei Richtungen, dieselbe Adresse)
// Ein Bit kann gleichzeitig Ausgang und Eingang sein — bei Modul 1A ist Bit 0
// das Relais der HWR-Deckenlampe und Bit 6 ein Lichtschalter; bei Modul 31 ist
// Bit 0 als Ausgang eine Steckdose und als Eingang der Lüftungsschalter.
export function buildConnectionIndex(data = CONNECTIONS) {
  const byAddr = new Map();
  const dimmers = new Map();     // "MM" -> Beschreibung des Dimmerkanals
  const put = (token, dir, entry) => {
    const cur = byAddr.get(token) || {};
    cur[dir] = entry;
    byAddr.set(token, cur);
  };
  for (const [mk, m] of Object.entries(data)) {
    for (const kind of ['A', 'S', 'E']) {
      for (const [nStr, desc] of Object.entries(m[kind] || {})) {
        const n = Number(nStr);
        if (isPlaceholder(desc)) continue;
        const addr = connectorAddress(kind, n, desc);
        if (!addr) continue;
        const connector = `${kind}${mk}/${n}`;
        if (addr.dimmer) { dimmers.set(mk, { desc, connector }); continue; }
        const token = `${mk}.${addr.sub}.${addr.bit}`;
        const dir = kind === 'A' ? 'out' : kind === 'S' ? 'led' : 'in';
        put(token, dir, { desc, connector, module: parseInt(mk, 16), ...addr,
                          wiring: WIRING.test(desc), fanDrive: FAN_DRIVE.test(desc) });
      }
    }
  }
  return { byAddr, dimmers, rooms: Object.fromEntries(
    Object.entries(data).filter(([, m]) => m.room).map(([k, m]) => [k, m.room])) };
}

// Name eines Rolladens aus den beiden Ausgängen ("… auf" / "… zu").
export function coverName(index, module, sub, bitDir, bitRun) {
  const a = index.byAddr.get(`${hx2(module)}.${sub}.${bitDir}`)?.out?.desc;
  const b = index.byAddr.get(`${hx2(module)}.${sub}.${bitRun}`)?.out?.desc;
  const strip = (s) => s && s.replace(/\s*(auf|zu|hoch|runter)\s*$/i, '').replace(/^rolladenausgang/i, 'Rolladen').trim();
  const na = strip(a), nb = strip(b);
  if (na && nb && na === nb) return na;
  return na || nb || null;
}

export const CONNECTION_DATA = CONNECTIONS;
export { hx2 as hexAddr };
