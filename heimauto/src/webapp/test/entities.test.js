// Entity derivation from the real rule base: the registry that gets reported to
// Home Assistant must find the plant's actual devices, with the right classes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RuleBase } from '../src/hrb.js';
import { deriveEntities, mergeOverrides, DIM } from '../src/entities.js';
import { MODULE_TYPES } from '../src/moduleinfo.js';

const rb = RuleBase.fromBuffer(readFileSync(new URL('../../RouleBase.hrb', import.meta.url)));
import { LABEL_SEED } from '../src/moduleinfo.js';
const labels = { ...LABEL_SEED };
const all = () => mergeOverrides(deriveEntities(rb, { labels }), {});
const byId = (id) => all().find((e) => e.id === id);

test('the HWR shutter is found as a cover with its rule-base travel time', () => {
  // rules: 19.0.0 := 0 ; 19.0.1 := 1 ; LST9 := 30.0
  const c = byId('cover_19_0_0');
  assert.ok(c, 'cover on module 0x19 must be derived');
  assert.equal(c.kind, 'cover');
  assert.equal(c.bitDir, 0);
  assert.equal(c.bitRun, 1);
  assert.equal(c.travelSec, 30, 'travel time comes from LST9 := 30.0');
});

test('module 0x22 carries three covers and a longer travel time', () => {
  const l = all().filter((e) => e.kind === 'cover' && e.module === 0x22);
  assert.deepEqual(l.map((e) => e.bitDir), [0, 2, 4]);
  assert.equal(l[0].travelSec, 50, '50 s run time for these shutters');
});

test('flag pairs (sub 1 / sub 7) are not mistaken for covers', () => {
  // 10.7.0 / 10.7.1 are the rule base's "already driven today" flags
  assert.equal(all().some((e) => e.kind === 'cover' && e.sub === 7), false);
  assert.equal(all().some((e) => e.kind === 'cover' && e.sub === 1), false);
});

test('the kitchen dimmer is found with its level/command columns', () => {
  const d = byId('light_11_dim');
  assert.ok(d, 'dimmer on module 0x11 must be derived');
  assert.equal(d.kind, 'dimmer');
  assert.equal(d.levelSub, 3);
  assert.equal(d.cmdSub, 4);
  assert.equal(d.levelMax, 0x40);
  assert.equal(d.stateBit, 5, '11.0.5 is the channel on/off memory');
});

test('das An/Aus-Merkerbit des Dimmers wird eingeklappt', () => {
  // 11.0.5 ist die An/Aus-Erinnerung des Küchendimmers, kein eigenes Gerät —
  // und die Anschlussliste kennt dort auch keine Klemme (A11/0..4).
  assert.equal(byId('switch_11_0_5'), undefined);
  assert.equal(byId('light_11_0_5'), undefined);
  // Dasselbe galt für 41.0.5: früher als „Licht hinter Garage" geführt, laut
  // Anschlussliste hängt die Lampe aber am Dimmerausgang A41/4.
  assert.equal(byId('light_41_0_5'), undefined);
  assert.equal(byId('light_41_dim').name, 'Lampe an Garage hinten zum Kompost');
});

test('ein benanntes Bit bleibt ein eigenes Gerät', () => {
  // Gibt der Nutzer einem Sub-0-Bit einen Namen, wird es nicht mehr in den
  // Dimmer eingeklappt — sonst wäre es aus der Oberfläche verschwunden.
  const list = mergeOverrides(deriveEntities(rb, { labels: { ...labels, '11.0.5': 'Licht Speisekammer extra' } }), {},
                              { labels: { ...labels, '11.0.5': 'Licht Speisekammer extra' } });
  const l = list.find((e) => e.id === 'light_11_0_5');
  assert.ok(l, 'ein benanntes Bit muss adressierbar bleiben');
  assert.equal(l.kind, 'light', 'der Name sagt „Licht" -> light, nicht switch');
});

test('the HWR light relay and its button are both found', () => {
  const light = byId('light_1a_0_0');
  assert.ok(light && light.kind === 'light' && light.module === 0x1a && light.bit === 0);
  const btn = byId('input_1a_0_6');
  assert.ok(btn && btn.kind === 'button', '1A.0.6 is the physical button');
});

test('timer-expiry event keys (sub 1) are not published as inputs', () => {
  // 0xC89 = ShortTimer #9 expiry of the HWR shutter, not a button
  assert.equal(all().some((e) => e.kind === 'button' && e.sub === 1), false);
});

test('rule-base flag bits are derived but disabled by default', () => {
  const flag = byId('switch_10_7_5');
  assert.ok(flag, 'the master enable bit 10.7.5 is still listed');
  assert.equal(flag.internal, true);
  assert.equal(flag.enabled, false, 'flags must not be reported unasked');
});

test('overrides win over the derivation and can enable a flag bit', () => {
  const list = mergeOverrides(deriveEntities(rb, { labels }), {
    entities: { switch_10_7_5: { name: 'Automatik aktiv', enabled: true },
                cover_19_0_0: { travelSec: 42, name: 'Rolladen HWR' } },
  });
  const flag = list.find((e) => e.id === 'switch_10_7_5');
  assert.equal(flag.enabled, true);
  assert.equal(flag.name, 'Automatik aktiv');
  const cov = list.find((e) => e.id === 'cover_19_0_0');
  assert.equal(cov.travelSec, 42);
  assert.equal(cov.name, 'Rolladen HWR');
});

test('a hand-added entity for an address the rules never use gets a name', () => {
  // 12.0.4 ist ein echter Taster, kommt aber in der Regelbasis nicht als
  // Auslöser vor — die Zuordnungskarte legt ihn von Hand an.
  const ov = { entities: { input_12_0_4: { kind: 'button', module: 0x12, sub: 0, bit: 4,
                                           enabled: true, source: 'manual', area: 'Küche' } } };
  // connections:false — hier geht es nur um die Namensauflösung der Overrides,
  // nicht um die Anschlussliste (die dokumentiert 12.0.4 als Sonnenfühler).
  const withLabel = mergeOverrides(deriveEntities(rb, { labels, connections: false }), ov,
                                   { labels: { ...labels, '12.0.4': 'Taster Küche Ost' } });
  const e = withLabel.find((x) => x.id === 'input_12_0_4');
  assert.equal(e.name, 'Taster Küche Ost', 'Klarname kommt aus der Label-Schicht');
  assert.equal(e.area, 'Küche');
  assert.equal(e.enabled, true);
  // ohne Klarnamen darf der Name nicht leer bleiben
  const noLabel = mergeOverrides(deriveEntities(rb, { labels, connections: false }), ov, { labels });
  assert.equal(noLabel.find((x) => x.id === 'input_12_0_4').name, 'Taster 12.0.4');
});

test('every entity of a real plant module is marked online, unknown ones not', () => {
  const list = mergeOverrides(deriveEntities(rb, { labels, modules: [0x19] }), {});
  assert.equal(list.find((e) => e.id === 'cover_19_0_0').online, true);
  assert.equal(list.find((e) => e.id === 'light_1a_0_0').online, false);
});

test('die Anschlussliste korrigiert einen Rolladen-Fehltreffer', () => {
  // Eine Zentral-Kette löscht 15.0.2 und 15.0.3 gemeinsam UND lädt einen Timer —
  // das sah wie ein Rolladen aus. Die Anschlussliste sagt: zwei Steckdosen
  // ("Erkerfenster mitte", von der Zeitschaltuhr 16:30 ein / 22:30 aus).
  assert.equal(byId('cover_15_0_2'), undefined);
  assert.equal(byId('switch_15_0_2').name, 'Steckdose Erkerfenster mitte rechte Seite');
  assert.equal(byId('switch_15_0_2').deviceClass, 'outlet');
  // ohne Anschlussliste greift der Fehltreffer wieder — der Beweis, dass die
  // Korrektur wirklich aus den Daten kommt
  const raw = mergeOverrides(deriveEntities(rb, { labels, connections: false }), {}, { labels });
  assert.ok(raw.find((e) => e.id === 'cover_15_0_2'), 'ohne Doku bleibt es ein Fehltreffer');
});

test('the derived registry covers the whole plant', () => {
  const list = all();
  const kinds = {};
  for (const e of list) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  assert.equal(kinds.cover, 19, '19 Rolladen (die Anschlussliste korrigiert einen Fehltreffer)');
  assert.ok(kinds.button > 100, 'over 100 physical inputs');
  assert.ok(kinds.switch + kinds.light > 40, 'relay outputs');
  assert.equal(kinds.fan, 1, 'die Lüftung (1C.0, 16 Stufen)');
  assert.equal(kinds.level, 1, 'der Betriebsart-Wähler (1C.7, 8 Stellungen)');
  assert.equal(DIM.APPLY, 0x30);
});

test('15 Dimmer nutzt die Regelbasis, 2 weitere sind nur Hardware', () => {
  // Laut ModulListe des Originals sind 17 Module Dimmer-Hardware; bei 16 und 18
  // benutzt die alte Konfiguration nur die Sub-0-Bits (Jalousien).
  const dim = all().filter((e) => e.kind === 'dimmer');
  const used = dim.filter((e) => !e.hardwareOnly);
  const spare = dim.filter((e) => e.hardwareOnly);
  assert.equal(used.length, 15);
  assert.deepEqual(spare.map((e) => e.module).sort((a, b) => a - b), [0x16, 0x18]);
  assert.equal(spare.every((e) => e.enabled === false), true,
    'brachliegende Hardware wird nicht ungefragt gemeldet');
  for (const e of used) {
    assert.equal(MODULE_TYPES[e.module.toString(16).toUpperCase()].type, 'Dimmer',
      `Modul ${e.module.toString(16)} muss laut Hardware ein Dimmer sein`);
  }
});

// Regression: das Add-on stürzte beim MQTT-Discovery mit
// "Cannot read properties of undefined (reading 'toString')" ab. Ursache: in
// data/entities.json standen kuratierte Entitäts-IDs aus einer älteren
// Ableitung. Aus `switch_40_0_0` war `light_40_0_0` geworden (die
// Anschlussliste sagt „Lampe vor Garage"), der verwaiste Eintrag wurde zu einer
// Entität OHNE Modul — und die kippte den ganzen Prozess.
test('kuratierte Overrides ziehen auf umbenannte Entitäts-IDs um', () => {
  const ov = { entities: {
    switch_40_0_0: { name: 'Lampe Kesslers', area: 'Hof' },      // heißt jetzt light_40_0_0
    cover_15_0_2: { name: 'War mal Rolladen', enabled: true },   // ist jetzt eine Steckdose
  } };
  const list = mergeOverrides(deriveEntities(rb, { labels }), ov, { labels });
  assert.deepEqual(list.migrations.map((x) => `${x.from}->${x.to}`),
                   ['switch_40_0_0->light_40_0_0', 'cover_15_0_2->switch_15_0_2']);
  const l = list.find((e) => e.id === 'light_40_0_0');
  assert.equal(l.name, 'Lampe Kesslers', 'der eigene Name überlebt die Umbenennung');
  assert.equal(l.area, 'Hof');
  assert.equal(list.find((e) => e.id === 'switch_40_0_0'), undefined, 'keine Geister-ID mehr');
});

test('ein Override ohne Adresse wird verworfen, nicht durchgelassen', () => {
  const ov = { entities: { kaputt: { name: 'ohne alles' }, 'x-y-z': { area: 'nirgends' } } };
  const list = mergeOverrides(deriveEntities(rb, { labels }), ov, { labels });
  assert.deepEqual(list.dropped.sort(), ['kaputt', 'x-y-z']);
  assert.equal(list.every((e) => Number.isInteger(e.module)), true,
    'jede Entität muss eine Modulnummer haben');
});

test('eine ID mit gültiger Adresse bleibt erhalten, auch ohne Regel und Klemme', () => {
  const ov = { entities: { input_55_3_2: { name: 'Taster Werkstatt', enabled: true } } };
  const list = mergeOverrides(deriveEntities(rb, { labels }), ov, { labels });
  const e = list.find((x) => x.id === 'input_55_3_2');
  assert.ok(e, 'von Hand angelegte Entitäten bleiben');
  assert.equal(e.module, 0x55);
  assert.equal(e.sub, 3);
  assert.equal(e.bit, 2);
  assert.equal(e.kind, 'button');
});
