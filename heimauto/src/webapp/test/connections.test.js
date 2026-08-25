// Die Zuordnung Klemme -> Busadresse ist die Brücke zwischen der
// Anschlussdokumentation der Anlage und der Regelbasis. Sie ist geraten, wenn
// sie nicht geprüft ist — hier wird sie gegen die Regelbasis, die
// Stufen-LED-Tabelle der Lüftung und die live geschaltete HWR-Lampe geprüft.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RuleBase } from '../src/hrb.js';
import { deriveEntities, mergeOverrides } from '../src/entities.js';
import { buildConnectionIndex, connectorAddress, classifyInput, classifyOutput, areaFor } from '../src/connections.js';
import { CONNECTIONS } from '../src/connections.data.js';
import { MODULE_TYPES, LABEL_SEED } from '../src/moduleinfo.js';

const rb = RuleBase.fromBuffer(readFileSync(new URL('../../RouleBase.hrb', import.meta.url)));
const idx = buildConnectionIndex();
const entities = mergeOverrides(deriveEntities(rb, { labels: LABEL_SEED }), {}, { labels: LABEL_SEED });
const byId = (id) => entities.find((e) => e.id === id);

test('die Dokumentation deckt alle 25 Module der Anlage ab', () => {
  assert.deepEqual(Object.keys(CONNECTIONS).sort(), Object.keys(MODULE_TYPES).sort());
});

test('Ausgangsklemmen liegen auf Sub 0, Bit = Klemmennummer', () => {
  assert.deepEqual(connectorAddress('A', 0, 'HWR Deckenlampe'), { sub: 0, bit: 0 });
  assert.deepEqual(connectorAddress('A', 7, 'Steckdose grosse Terrasse'), { sub: 0, bit: 7 });
  // live verifiziert: `E5 1A 00 01 01` schaltet das Relais an A1A/0
  assert.equal(idx.byAddr.get('1A.0.0').out.desc, 'HWR Deckenlampe');
  assert.equal(byId('light_1a_0_0').connector, 'A1A/0');
});

test('als „Dimmer" markierte Ausgänge sind der Dimmerkanal, kein Relaisbit', () => {
  assert.deepEqual(connectorAddress('A', 4, 'Dimmausgang Lampe Küche [Dimmer]'), { dimmer: true });
  // 17 dokumentierte Dimmerkanäle = genau die 17 Dimmer-Module der ModulListe
  const dimModules = Object.entries(MODULE_TYPES).filter(([, v]) => v.type === 'Dimmer').map(([k]) => k);
  assert.deepEqual([...idx.dimmers.keys()].sort(), dimModules.sort());
});

test('Status-LEDs liegen auf Sub 1 — bewiesen durch die Lüftungsanzeige', () => {
  assert.deepEqual(connectorAddress('S', 3, 'egal'), { sub: 1, bit: 3 });
  // S31/0..7 = "1.…8. LED von links Lüftungsanzeige Flur oben"; genau diese acht
  // Bits schreibt die Stufen-LED-Tabelle der Lüftung.
  const fan = byId('level_1c_0');
  const bits = new Set();
  for (const table of Object.values(fan.indicators)) {
    for (const t of table) if (t.module === 0x31 && t.sub === 1) {
      for (let b = 0; b < 8; b++) if (((t.set | t.clr) >> b) & 1) bits.add(b);
    }
  }
  assert.deepEqual([...bits].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  for (let b = 0; b < 8; b++) {
    assert.match(idx.byAddr.get(`31.1.${b}`).led.desc, /LED von links Lüftungsanzeige Flur oben/);
  }
  // und die acht Wohnzimmer-Anzeigen liegen ebenfalls auf Sub 1
  for (const t of ['10.1.2', '11.1.2', '13.1.2', '15.1.2', '18.1.2', '19.1.2', '1B.1.0', '1B.1.2']) {
    assert.match(idx.byAddr.get(t).led.desc, /Ausgang Anzeige Lüftung im Wohnzimmer/, t);
  }
});

test('Eingänge ab Nummer 8 liegen auf Sub 2 — bewiesen durch echte Auslöser', () => {
  assert.deepEqual(connectorAddress('E', 7, 'x'), { sub: 0, bit: 7 });
  assert.deepEqual(connectorAddress('E', 8, 'x'), { sub: 2, bit: 0 });
  assert.deepEqual(connectorAddress('E', 11, 'x'), { sub: 2, bit: 3 });
  // E10/10 und E10/11 sind der zweite Rolladentaster im Gästezimmer; die
  // Regelbasis hat genau dort die Auslöser 10.2.2 und 10.2.3.
  assert.match(idx.byAddr.get('10.2.2').in.desc, /Rolladenschalter Gästezimmer an Tür auf/);
  assert.match(idx.byAddr.get('10.2.3').in.desc, /Rolladenschalter Gästezimmer an Tür zu/);
  const triggers = new Set(rb.commandRuns().map((r) => r.entry.groupId));
  assert.ok(triggers.has((0x10 << 7) | (2 * 8 + 2)), 'Auslöser 10.2.2 existiert');
  assert.ok(triggers.has((0x10 << 7) | (2 * 8 + 3)), 'Auslöser 10.2.3 existiert');
  assert.ok(triggers.has((0x30 << 7) | (2 * 8 + 1)), 'Auslöser 30.2.1 existiert');
});

test('jeder Auslöser der Regelbasis auf Sub 0/2 hat eine Klemme in der Liste', () => {
  const missing = [];
  for (const run of rb.commandRuns()) {
    const g = run.entry.groupId;
    const M = (g >> 7) & 0xff, ev = g & 0x7f, sub = (ev >> 3) & 0x0f, bit = ev & 7;
    if (M === 0 || sub === 1) continue;                     // Zeit / Timer-Ablauf
    const token = `${M.toString(16).toUpperCase().padStart(2, '0')}.${sub}.${bit}`;
    if (!idx.byAddr.get(token)?.in) missing.push(token);
  }
  // Zwei Auslöser der Regelbasis stehen in keiner Liste (Zusatzbelegungen);
  // mehr wäre ein Zeichen für eine falsche Zuordnung.
  assert.ok(new Set(missing).size <= 3, `zu viele Auslöser ohne Klemme: ${[...new Set(missing)]}`);
});

test('Geräteklassen kommen aus dem Beschreibungstext', () => {
  assert.equal(classifyInput('Rauchmelder Gästezimmer').deviceClass, 'smoke');
  assert.equal(classifyInput('Bewegungsmelder Carport').deviceClass, 'motion');
  assert.equal(classifyInput('Readkontakt Haustür').deviceClass, 'opening');
  assert.equal(classifyInput('Sabotagekontakt Küche gesamt').deviceClass, 'tamper');
  assert.equal(classifyInput('Paniktaster Gästezimmer').deviceClass, 'safety');
  assert.equal(classifyOutput('Steckdose Fenster').deviceClass, 'outlet');
  assert.equal(classifyOutput('HWR Deckenlampe').kind, 'light');
  assert.equal(classifyOutput('Rolladen Bad auf').kind, 'cover');
  // im Ergebnis: die Sensorik der Anlage ist in Home Assistant richtig klassiert
  assert.equal(byId('input_10_0_6').deviceClass, 'smoke');
  assert.equal(byId('input_20_0_2').deviceClass, 'opening');
  assert.equal(byId('switch_40_0_7').deviceClass, 'outlet');
});

test('Räume kommen aus dem Text, nicht aus dem Einbauort des Moduls', () => {
  assert.equal(areaFor('Rolladenausgang Speisekammer auf'), 'Speisekammer');
  assert.equal(areaFor('Dimmausgang Lampe Küche'), 'Küche');
  // Modul 11 steckt im Gästezimmer, schaltet aber Speisekammer und Küche
  assert.equal(byId('cover_11_0_0').area, 'Speisekammer');
  assert.equal(byId('light_11_dim').area, 'Küche');
  assert.equal(byId('cover_11_0_0').areaGuess, undefined, 'aus dem Text, keine Vermutung');
  // ohne Raum im Text wird der Einbauort als Vermutung markiert
  const guess = entities.find((e) => e.areaGuess);
  assert.ok(guess, 'es gibt geschätzte Räume');
});

test('Anschlüsse ohne Regel werden ergänzt — Lichter ein, Kabelnotizen aus', () => {
  // Drei Flurlichter auf Modul 1A, die die alte Konfiguration nie schaltet
  for (const b of [1, 2, 3]) {
    const e = byId(`light_1a_0_${b}`);
    assert.ok(e, `1A.0.${b} muss angelegt werden`);
    assert.equal(e.enabled, true);
    assert.equal(e.unusedByRules, true);
    assert.match(e.name, /Flurlicht/);
  }
  // Verkabelungsnotizen und die Lüftermotor-Relais werden NICHT gemeldet
  assert.equal(byId('switch_30_0_3').enabled, false, 'KABEL zur Verteilerdose');
  assert.equal(byId('switch_30_0_3').wiring, true);
  const fanRelay = entities.find((e) => e.module === 0x1b && e.sub === 0 && e.kind !== 'button' && e.fanDrive);
  assert.ok(fanRelay, 'die Lüftermotor-Relais sind dokumentiert');
  assert.equal(fanRelay.enabled, false, 'ein Lüftermotor ist kein Einzelschalter');
  // die 8 Relais des Stufenregisters 1C erscheinen NICHT als Einzelschalter
  assert.equal(entities.some((e) => e.module === 0x1c && e.sub === 0 && e.kind === 'switch'), false);
});

test('die Sensorik der Anlage ist vollständig gemeldet', () => {
  const cls = (c) => entities.filter((e) => e.kind === 'button' && e.deviceClass === c && e.enabled !== false).length;
  assert.ok(cls('opening') >= 20, `Fenster-/Türkontakte: ${cls('opening')}`);
  assert.ok(cls('smoke') >= 4, `Rauchmelder: ${cls('smoke')}`);
  assert.ok(cls('motion') >= 4, `Bewegungsmelder: ${cls('motion')}`);
  assert.ok(cls('tamper') >= 10, `Sabotagekontakte: ${cls('tamper')}`);
});

test('die Lüftungstaster behalten die verifizierte Richtung', () => {
  // Die Anschlussliste hat bei Modul 1B „mehr/weniger Luft" vertauscht:
  // laut Regelbasis und Original-Log ist Bit 7 „höher" (1C.0 += $11).
  assert.match(idx.byAddr.get('1B.0.6').in.desc, /mehr Luft/, 'so steht es in der Liste');
  assert.match(idx.byAddr.get('1B.0.7').in.desc, /weniger Luft/, 'so steht es in der Liste');
  assert.match(byId('input_1b_0_7').name, /höher/, 'so ist es wirklich');
  assert.match(byId('input_1b_0_6').name, /niedriger/, 'so ist es wirklich');
});
