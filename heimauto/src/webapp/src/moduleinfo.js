// Hardware-Inventar der Anlage.
//
// Quelle: der Tab "ModulListe" des Original-Programms (FunctionSim), abgelesen
// am 2026-08-25. Die Module melden ihren Typ selbst über einen SignaturString
// ("HomeBus-Dimmer V1.6, (c)Thomas Manthey 2002-2005 all rights reserved"); das
// Kommando dafür ist noch nicht reverse-engineert, deshalb steht die Liste hier
// als Stammdaten und kann über data/modules.json überschrieben/ergänzt werden.
//
// Gegenprobe zur Entitäten-Ableitung: JEDES der 15 Module, für die die
// Regelbasis das Dimmer-Protokoll (M.3 Pegel + M.4 Kommando) benutzt, meldet
// sich hier als "HomeBus-Dimmer" — kein Relais-Modul wird gedimmt, das
// Analog-Modul 1C bekommt keins von beiden. Umgekehrt gilt es NICHT: 17 Module
// sind Dimmer-Hardware, aber bei 16 und 18 nutzt die alte Konfiguration nur die
// Sub-0-Bits (Jalousien) — deren Dimmer-Kanal liegt brach.
//
// Die Spalten IC und OC der ModulListe sind hier mitgeführt, aber NICHT
// interpretiert: für Dimmer/Relais passen sie zu einer Spaltenmaske
// (Dimmer OC=1F -> Sub 0..4, Relais OC=03 -> Sub 0..1), für Modul 12 (00/00)
// und 1A (60/FF) nicht. Sie werden deshalb nur angezeigt, nie ausgewertet.

export const MODULE_TYPES = {
  '10': { type: 'Dimmer', version: 'V2.0',   hw: 0x95, date: '20060106', ic: 0x1f, oc: 0x3f },
  '11': { type: 'Dimmer', version: 'V1.6',   hw: 0x93, date: '20050420', ic: 0x1d, oc: 0x1f },
  '12': { type: 'Relais', version: 'V1.3',   hw: 0x72, date: '20050325', ic: 0x00, oc: 0x00 },
  '13': { type: 'Dimmer', version: 'V1.6',   hw: 0x93, date: '20050420', ic: 0x1d, oc: 0x1f },
  '14': { type: 'Dimmer', version: 'V1.6',   hw: 0x93, date: '20050420', ic: 0x1d, oc: 0x1f },
  '15': { type: 'Dimmer', version: 'V1.6',   hw: 0x93, date: '20050420', ic: 0x1d, oc: 0x1f },
  '16': { type: 'Dimmer', version: 'V1.6',   hw: 0x93, date: '20050420', ic: 0x1d, oc: 0x1f },
  '17': { type: 'Relais', version: 'V1.3',   hw: 0x72, date: '20050325', ic: 0x01, oc: 0x03 },
  '18': { type: 'Dimmer', version: 'V1.6',   hw: 0x93, date: '20050420', ic: 0x1d, oc: 0x1f },
  '19': { type: 'Dimmer', version: 'V1.6',   hw: 0x93, date: '20050420', ic: 0x1d, oc: 0x1f },
  '1A': { type: 'Relais', version: 'V1.3',   hw: 0x72, date: '20050325', ic: 0x60, oc: 0xff },
  '1B': { type: 'Relais', version: 'V1.3',   hw: 0x72, date: '20050325', ic: 0x01, oc: 0x03 },
  '1C': { type: 'Analog', version: 'V1.3',   hw: 0x7a, date: '20050410', ic: 0x01, oc: 0x03 },
  '20': { type: 'Dimmer', version: 'V1.6',   hw: 0x93, date: '20050420', ic: 0x1d, oc: 0x1f },
  '21': { type: 'Dimmer', version: 'V1.6',   hw: 0x93, date: '20050420', ic: 0x1d, oc: 0x1f },
  '22': { type: 'Relais', version: 'V1.3',   hw: 0x72, date: '20050325', ic: 0x01, oc: 0x03 },
  '23': { type: 'Dimmer', version: 'V1.6',   hw: 0x93, date: '20050420', ic: 0x1d, oc: 0x1f },
  '24': { type: 'Dimmer', version: 'V1.6',   hw: 0x93, date: '20050420', ic: 0x1d, oc: 0x1f },
  '30': { type: 'Dimmer', version: 'V2.1',   hw: 0x98, date: '20081227', ic: 0x1f, oc: 0x3f },
  '31': { type: 'Dimmer', version: 'V2.202', hw: 0x98, date: '20121111', ic: 0x1f, oc: 0x3f },
  '40': { type: 'Relais', version: 'V1.2',   hw: 0x72, date: '20050309', ic: 0x01, oc: 0x03 },
  '41': { type: 'Dimmer', version: 'V1.6',   hw: 0x93, date: '20050802', ic: 0x1d, oc: 0x1f },
  '42': { type: 'Dimmer', version: 'V1.6',   hw: 0x93, date: '20050812', ic: 0x1d, oc: 0x1f },
  '43': { type: 'Dimmer', version: 'V1.6',   hw: 0x93, date: '20050802', ic: 0x1d, oc: 0x1f },
  '44': { type: 'Relais', version: 'V1.3',   hw: 0x72, date: '20050812', ic: 0x01, oc: 0x03 },
};

// Bedeutung der Sub-Adressen, so wie die Anlage sie tatsächlich benutzt
// (aus der Regelbasis und den Original-Logs vom 2026-08-25 belegt).
export const SUB_ROLES = {
  0: 'Ein-/Ausgänge (Taster, Relais, Motorbits)',
  1: 'Status-LEDs der Taster',
  2: 'Betriebsart',
  3: 'Dimmer-Pegel',
  4: 'Dimmer-Kommando',
  7: 'Merker der Regelbasis (nicht physisch)',
  15: 'Anmelde-/Handshake-Spalte',
};

// Klarnamen, die aus dem Reverse-Engineering und den Original-Logs belegt sind.
// Sie füllen nur Lücken — eigene Namen des Nutzers (data/labels.json) gewinnen.
// Die Lüftungs-Einträge sind durch die Logs vom 2026-08-25 belegt: 1C.0 ist das
// Stufenregister (16 Stufen à 0x11), bedient von zwei Tasterpaaren.
export const LABEL_SEED = {
  'trigger:8': 'Zeit – jede Minute (Zeitschaltuhr)',
  '1C.0': 'Lüftung',
  // Die Anschlussliste hat bei Modul 1B „mehr/weniger Luft" vertauscht: laut
  // Regelbasis UND Original-Log ist Bit 7 „höher" (1C.0 += $11) und Bit 6
  // „niedriger". Die Klarnamen hier halten die verifizierte Richtung fest.
  '1B.0.7': 'Lüftung Wohnzimmer – höher',
  '1B.0.6': 'Lüftung Wohnzimmer – niedriger',
  '31.0.1': 'Lüftung Flur OG – höher',
  '31.0.0': 'Lüftung Flur OG – niedriger',
  '1A': 'Hauswirtschaftsraum (HWR)',
};
// Alles andere kommt aus der Anschlussdokumentation (src/connections.data.js):
// sie ist genauer als die früheren Einzelbelege aus dem Reverse-Engineering
// (z. B. war „41.0.5 = Licht hinter Garage" das An/Aus-Merkerbit des Dimmers —
// die Lampe selbst hängt an A41/4 „Lampe an Garage hinten zum Kompost").

export function moduleInfo(addr, overrides = {}) {
  const key = (addr & 0xff).toString(16).toUpperCase().padStart(2, '0');
  const base = MODULE_TYPES[key] || null;
  const ov = overrides[key] || null;
  if (!base && !ov) return null;
  return { addr: addr & 0xff, hexAddr: key, ...(base || {}), ...(ov || {}) };
}

export function moduleLabel(addr, overrides = {}) {
  const info = moduleInfo(addr, overrides);
  const key = (addr & 0xff).toString(16).toUpperCase().padStart(2, '0');
  return info ? `HomeBus-${info.type} ${key}` : `HomeBus Modul ${key}`;
}
