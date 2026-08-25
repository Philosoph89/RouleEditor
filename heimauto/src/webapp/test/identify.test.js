// Live-Zuordnung: was die Karte beim Tastendruck anzeigt, muss aus der echten
// Regelbasis stammen — inklusive der Auflösung relativer Adressen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RuleBase } from '../src/hrb.js';
import { deriveEntities, mergeOverrides } from '../src/entities.js';
import { buildIndex, identifyInput, describeOutputs, entityForOutput, eventKeyOf, touchedMask } from '../src/identify.js';

const rb = RuleBase.fromBuffer(readFileSync(new URL('../../RouleBase.hrb', import.meta.url)));
const labels = { '1A.0.0': 'HWR Licht (Relais)', '1A.0.6': 'HWR Taster' };
const entities = mergeOverrides(deriveEntities(rb, { labels }), {});
const index = buildIndex(rb);
const ident = (module, sub, bit, value) => identifyInput({ module, sub, bit, value }, { index, entities, labels });

test('der HWR-Taster wird mit Name, Entität und Event-Key erkannt', () => {
  const r = ident(0x1a, 0, 6, 0x40);
  assert.equal(r.token, '1A.0.6');
  assert.equal(r.eventKeyHex, '0xD06');
  assert.equal(r.label, 'HWR Taster');
  assert.equal(r.entity.id, 'input_1a_0_6');
  assert.equal(r.pressed, true, 'Bit 6 gesetzt = gedrückt');
  assert.equal(r.known, true);
});

test('die Karte nennt das Gerät, das dieser Taster im Original schaltet', () => {
  // Regel 0xD06:  00.0.6 == 1 ;  1A.0.0 ~= 1A.0.0
  const r = ident(0x1a, 0, 6, 0x40);
  assert.equal(r.chains.length, 1);
  assert.match(r.chains[0].when.join(' '), /00\.0\.6/);
  assert.match(r.chains[0].then.join(' '), /1A\.0\.0/);
  assert.equal(r.outputs.length, 1);
  assert.equal(r.outputs[0].entity.id, 'light_1a_0_0');
  assert.equal(r.outputs[0].entity.name, 'HWR Licht (Relais)');
});

test('der Rolladen-Taster zeigt die Jalousie als Ausgang, nicht zwei Bits', () => {
  // 0xC87: 19.0.0 / 19.0.1 sind Richtung + Motor EINER Jalousie
  const r = ident(0x19, 0, 7, 0x80);
  const covers = r.outputs.filter((o) => o.entity?.kind === 'cover');
  assert.ok(covers.length >= 1, 'die Jalousie muss auftauchen');
  assert.equal(new Set(covers.map((o) => o.entity.id)).size, 1, 'beide Bits = eine Entität');
  assert.equal(covers[0].entity.id, 'cover_19_0_0');
});

test('der Küchen-Dimmertaster zeigt den Dimmer eines ANDEREN Moduls', () => {
  // 0x907: Taster auf Modul 0x12 steuert den Dimmer auf Modul 0x11
  const r = ident(0x12, 0, 7, 0x80);
  const dim = r.outputs.find((o) => o.entity?.kind === 'dimmer');
  assert.ok(dim, 'der Dimmer muss aufgelöst werden');
  assert.equal(dim.entity.id, 'light_11_dim');
  assert.equal(dim.module, 0x11);
});

test('relative Adressen (00.x.y) werden auf das auslösende Modul aufgelöst', () => {
  const r = ident(0x0a, 0, 0, 0x01);   // Modul ohne eigene Regeln
  for (const o of r.outputs) {
    if (o.relative) assert.equal(o.module, 0x0a, 'relatives Ziel = auslösendes Modul');
  }
  // und in einer echten Kette mit relativem Ziel
  const withRel = [0x10, 0x12, 0x14, 0x18, 0x1b]
    .flatMap((m) => [0, 1, 4, 5, 6, 7].map((b) => ident(m, 0, b, 1 << b)))
    .flatMap((r2) => r2.outputs.filter((o) => o.relative));
  for (const o of withRel) assert.ok(o.module !== 0x00, 'kein Ziel bleibt auf Modul 00 stehen');
});

test('ein unbekannter Eingang liefert eine Karte ohne Entität statt eines Fehlers', () => {
  const r = ident(0x55, 3, 2, 0x04);
  assert.equal(r.token, '55.3.2');
  assert.equal(r.entity, null);
  assert.equal(r.label, null);
  assert.equal(r.known, false);
  assert.deepEqual(r.chains, []);
  assert.deepEqual(r.outputs, []);
});

test('gedrückt/gelöst kommt aus dem Bitwert', () => {
  assert.equal(ident(0x1a, 0, 6, 0x00).pressed, false);
  assert.equal(ident(0x1a, 0, 6, 0xff).pressed, true);
});

test('Event-Key-Bildung stimmt mit dem Interpreter überein', () => {
  assert.equal(eventKeyOf(0x1a, 0, 6), 0xd06);
  assert.equal(eventKeyOf(0x19, 0, 7), 0xc87);
  assert.equal(eventKeyOf(0x12, 0, 7), 0x907);
});

test('gelaufene Ausgänge werden auf Entitäten mit Zustand aufgelöst', () => {
  // Ein Ausgang ist ein ganzes Sub-Byte — es können mehrere Geräte daran hängen.
  const out = describeOutputs([{ module: 0x1a, sub: 0, value: 0x01 },
                               { module: 0x11, sub: 3, value: 0x40 },
                               { module: 0x19, sub: 0, value: 0x02 }], { entities, labels });
  assert.equal(out[0].entity.id, 'light_1a_0_0');
  assert.equal(out[0].state, 'EIN');
  assert.equal(out[0].hex, '0x01');
  assert.equal(out[1].entity.id, 'light_11_dim', 'Pegelbyte gehört zum Dimmer');
  assert.equal(out[1].state, 'Pegel 100 %');
  const cover = out[2].devices.find((d) => d.entity.kind === 'cover');
  assert.equal(cover.entity.id, 'cover_19_0_0');
  assert.equal(cover.state, 'fährt zu', 'Bit1 = Motor, Bit0 = 0 -> abwärts');
});

test('nur die Bits, die die Ketten anfassen, werden als Gerät gemeldet', () => {
  // Der Küchen-Dimmertaster (0x907) fasst auf Modul 0x11 nur Bit 5 an. Ohne
  // Maske erschien die Jalousie 11.0.0/11.0.1 desselben Bytes als "Stopp".
  const touched = touchedMask(index, 0x907, 0x12);
  const out = describeOutputs([{ module: 0x11, sub: 0, value: 0x20 }], { entities, labels, touched });
  assert.equal(out[0].devices.some((d) => d.entity.kind === 'cover'), false,
    'die Jalousie desselben Bytes darf nicht auftauchen');
  // ohne Maske schlägt genau dieser Fall zu (deshalb gibt es sie)
  const raw = describeOutputs([{ module: 0x11, sub: 0, value: 0x20 }], { entities, labels });
  assert.equal(raw[0].devices.some((d) => d.entity.kind === 'cover'), true);
});

test('relative Ziele werden in der Maske auf das auslösende Modul gelegt', () => {
  // 0x887: Taster auf Modul 0x11 stoppt die Jalousie auf Modul 0x10
  const touched = touchedMask(index, 0x887, 0x11);
  assert.ok(touched.has('10.0'), 'absolutes Ziel 10.0 ist erfasst');
  const out = describeOutputs([{ module: 0x10, sub: 0, value: 0x00 }], { entities, labels, touched });
  assert.equal(out[0].devices[0].entity.id, 'cover_10_0_0');
  assert.equal(out[0].devices[0].state, 'Stopp');
});

test('ein Ausgangsbyte mit mehreren Relais nennt jedes einzeln', () => {
  const out = describeOutputs([{ module: 0x40, sub: 0, value: 0x03 }], { entities, labels });
  const on = out[0].devices.filter((d) => d.on === true).map((d) => d.entity.id);
  const off = out[0].devices.filter((d) => d.on === false).map((d) => d.entity.id);
  assert.deepEqual(on, ['switch_40_0_0', 'switch_40_0_1'], 'Bit 0 und 1 sind EIN');
  assert.ok(off.length > 0 && !off.some((id) => on.includes(id)), 'die übrigen sind AUS');
});

test('entityForOutput trifft Jalousie über beide Bits und Dimmer über beide Spalten', () => {
  assert.equal(entityForOutput(entities, 0x19, 0, 0).id, 'cover_19_0_0');
  assert.equal(entityForOutput(entities, 0x19, 0, 1).id, 'cover_19_0_0');
  assert.equal(entityForOutput(entities, 0x11, 3).id, 'light_11_dim');
  assert.equal(entityForOutput(entities, 0x11, 4).id, 'light_11_dim');
  assert.equal(entityForOutput(entities, 0x99, 0, 0), null);
});

test('der Index findet jede Kette der Regelbasis wieder', () => {
  const total = [...index.values()].reduce((n, l) => n + l.length, 0);
  assert.equal(total, rb.commandRuns().length, 'keine Kette darf verloren gehen');
  assert.ok(index.has(0xd06) && index.has(8), 'Taster- und Zeit-Auslöser sind indiziert');
});
