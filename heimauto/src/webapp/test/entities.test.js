// Entity derivation from the real rule base: the registry that gets reported to
// Home Assistant must find the plant's actual devices, with the right classes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RuleBase } from '../src/hrb.js';
import { deriveEntities, mergeOverrides, DIM } from '../src/entities.js';

const rb = RuleBase.fromBuffer(readFileSync(new URL('../../RouleBase.hrb', import.meta.url)));
const labels = { '1A.0.0': 'HWR Licht (Relais)', '41.0.5': 'Licht hinter Garage' };
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

test('a dimmer state bit is folded away, a NAMED bit stays its own device', () => {
  // 11.0.5 has no label -> folded into light_11_dim
  assert.equal(byId('switch_11_0_5'), undefined);
  // 41.0.5 is labelled "Licht hinter Garage" -> keeps its own entity
  const l = byId('light_41_0_5');
  assert.ok(l, 'a named bit must stay addressable');
  assert.equal(l.kind, 'light', 'the label says "Licht" -> light, not switch');
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
  const withLabel = mergeOverrides(deriveEntities(rb, { labels }), ov,
                                   { labels: { ...labels, '12.0.4': 'Taster Küche Ost' } });
  const e = withLabel.find((x) => x.id === 'input_12_0_4');
  assert.equal(e.name, 'Taster Küche Ost', 'Klarname kommt aus der Label-Schicht');
  assert.equal(e.area, 'Küche');
  assert.equal(e.enabled, true);
  // ohne Klarnamen darf der Name nicht leer bleiben
  const noLabel = mergeOverrides(deriveEntities(rb, { labels }), ov, { labels });
  assert.equal(noLabel.find((x) => x.id === 'input_12_0_4').name, 'Taster 12.0.4');
});

test('every entity of a real plant module is marked online, unknown ones not', () => {
  const list = mergeOverrides(deriveEntities(rb, { labels, modules: [0x19] }), {});
  assert.equal(list.find((e) => e.id === 'cover_19_0_0').online, true);
  assert.equal(list.find((e) => e.id === 'light_1a_0_0').online, false);
});

test('the derived registry covers the whole plant', () => {
  const list = all();
  const kinds = {};
  for (const e of list) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  assert.equal(kinds.cover, 20, '20 shutters');
  assert.equal(kinds.dimmer, 15, '15 dimmer channels');
  assert.ok(kinds.button > 100, 'over 100 physical inputs');
  assert.ok(kinds.switch + kinds.light > 40, 'relay outputs');
  assert.equal(DIM.APPLY, 0x30);
});
