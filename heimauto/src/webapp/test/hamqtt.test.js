// MQTT discovery payloads: what Home Assistant actually receives. No broker
// needed — discoveryConfig() is pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';
import { HaMqtt } from '../src/hamqtt.js';

const ENT = [
  { id: 'light_1a_0_0', kind: 'light', module: 0x1a, sub: 0, bit: 0, name: 'HWR Licht', area: 'HWR' },
  { id: 'cover_19_0_0', kind: 'cover', module: 0x19, sub: 0, bitDir: 0, bitRun: 1, travelSec: 30, name: 'Rolladen HWR', deviceClass: 'shutter' },
  { id: 'light_11_dim', kind: 'dimmer', module: 0x11, levelSub: 3, cmdSub: 4, levelMax: 0x40, name: 'Küche' },
  { id: 'input_1a_0_6', kind: 'button', module: 0x1a, sub: 0, bit: 6, name: 'HWR Taster' },
];

function setup() {
  const bridge = new Bridge({ queueOutput: () => {} });
  bridge.setEntities(ENT);
  const ha = new HaMqtt(bridge);
  ha.setEntities(ENT);
  return { bridge, ha };
}

test('a relay becomes a switch/light with command and state topic', () => {
  const { ha } = setup();
  const { comp, cfg } = ha.discoveryConfig(ENT[0]);
  assert.equal(comp, 'light');
  assert.equal(cfg.unique_id, 'heimauto_light_1a_0_0');
  assert.equal(cfg.command_topic, 'heimauto/light_1a_0_0/set');
  assert.equal(cfg.state_topic, 'heimauto/light_1a_0_0/state');
  assert.equal(cfg.availability_topic, 'heimauto/status');
  assert.deepEqual(cfg.device.identifiers, ['heimauto_mod_1a']);
  // suggested_area sitzt bei MQTT am Gerät und wird nur gesetzt, wenn alle
  // gemeldeten Entitäten des Moduls im selben Raum liegen. Modul 1A hat hier
  // eine Entität ohne Raum (der Taster), also bleibt es leer.
  assert.equal(cfg.device.suggested_area, undefined);
});

test('a cover gets position topics so HA can drive it to a percentage', () => {
  const { ha } = setup();
  const { comp, cfg } = ha.discoveryConfig(ENT[1]);
  assert.equal(comp, 'cover');
  assert.equal(cfg.set_position_topic, 'heimauto/cover_19_0_0/set_position');
  assert.equal(cfg.position_topic, 'heimauto/cover_19_0_0/position');
  assert.equal(cfg.device_class, 'shutter');
  assert.equal(cfg.position_open, 100);
});

test('a dimmer is a JSON light with brightness', () => {
  const { ha } = setup();
  const { comp, cfg } = ha.discoveryConfig(ENT[2]);
  assert.equal(comp, 'light');
  assert.equal(cfg.schema, 'json');
  assert.equal(cfg.brightness, true);
});

test('an input is a binary_sensor with no command topic', () => {
  const { ha } = setup();
  const { comp, cfg } = ha.discoveryConfig(ENT[3]);
  assert.equal(comp, 'binary_sensor');
  assert.equal(cfg.command_topic, undefined);
  assert.equal(cfg.state_topic, 'heimauto/input_1a_0_6/state');
});

test('ein eindeutiger Raum landet am Gerät, ein mehrdeutiger nicht', () => {
  const bridge = new Bridge({ queueOutput: () => {} });
  const ha = new HaMqtt(bridge);
  // Modul 1A: beide Entitäten im HWR -> Raum am Gerät
  const same = [{ ...ENT[0], area: 'HWR' }, { ...ENT[3], area: 'HWR' }];
  ha.setEntities(same);
  assert.equal(ha.discoveryConfig(same[0]).cfg.device.suggested_area, 'HWR');
  // dasselbe Modul mit zwei Räumen -> kein Raum am Gerät
  ha.setEntities([{ ...ENT[0], area: 'HWR' }, { ...ENT[3], area: 'Flur' }]);
  assert.equal(ha.discoveryConfig(ENT[0]).cfg.device.suggested_area, undefined);
});

test('every module becomes its own Home Assistant device', () => {
  const { ha } = setup();
  const ids = ENT.map((e) => ha.discoveryConfig(e).cfg.device.identifiers[0]);
  assert.deepEqual(ids, ['heimauto_mod_1a', 'heimauto_mod_19', 'heimauto_mod_11', 'heimauto_mod_1a']);
});

test('an incoming MQTT command reaches the bridge', () => {
  const { bridge, ha } = setup();
  const cmds = [];
  bridge.command = (id, cmd) => { cmds.push([id, cmd]); return {}; };
  ha._onMessage('heimauto/light_1a_0_0/set', Buffer.from('ON'));
  ha._onMessage('heimauto/light_11_dim/set', Buffer.from('{"state":"ON","brightness":128}'));
  ha._onMessage('heimauto/cover_19_0_0/set_position', Buffer.from('40'));
  ha._onMessage('heimauto/cover_19_0_0/set', Buffer.from('STOP'));
  assert.deepEqual(cmds, [
    ['light_1a_0_0', 'ON'],
    ['light_11_dim', { state: 'ON', brightness: 128 }],
    ['cover_19_0_0', { position: 40 }],
    ['cover_19_0_0', 'STOP'],
  ]);
});

test('a rejected command is logged, not thrown', () => {
  const { bridge, ha } = setup();
  const logs = [];
  ha.onLog = (m) => logs.push(m);
  ha._onMessage('heimauto/input_1a_0_6/set', Buffer.from('ON'));
  assert.equal(ha.stats.errors, 1);
  assert.match(logs.join(' '), /abgelehnt/);
});

test('foreign topics are ignored', () => {
  const { bridge, ha } = setup();
  let called = 0;
  bridge.command = () => { called++; return {}; };
  ha._onMessage('somewhere/else/set', Buffer.from('ON'));
  ha._onMessage('heimauto/light_1a_0_0/state', Buffer.from('ON'));
  assert.equal(called, 0);
});
