// End-to-end over a real MQTT broker (aedes, in-process): discovery is
// published, a Home Assistant command arrives as a HomeBus output byte, and an
// input change is published back as a state.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { Bridge } from '../src/bridge.js';
import { HaMqtt } from '../src/hamqtt.js';

const ENT = [
  { id: 'light_1a_0_0', kind: 'light', module: 0x1a, sub: 0, bit: 0, name: 'HWR Licht' },
  { id: 'cover_19_0_0', kind: 'cover', module: 0x19, sub: 0, bitDir: 0, bitRun: 1, travelSec: 30, name: 'Rolladen' },
  { id: 'input_1a_0_6', kind: 'button', module: 0x1a, sub: 0, bit: 6, name: 'Taster' },
];

async function startBroker() {
  const aedes = await Aedes.createBroker();
  const server = net.createServer(aedes.handle);
  await new Promise((r) => server.listen(0, r));
  return { aedes, server, port: server.address().port };
}

const waitFor = (fn, ms = 3000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const v = fn();
    if (v) { clearInterval(iv); resolve(v); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timeout')); }
  }, 20);
});

test('discovery, command and state travel over a real broker', async (t) => {
  const { aedes, server, port } = await startBroker();
  const sent = [];
  const bridge = new Bridge({ queueOutput: (M, sub, val) => sent.push({ M, sub, val }) });
  bridge.setEntities(ENT);
  const ha = new HaMqtt(bridge);
  ha.setEntities(ENT);
  bridge.onState = (e, st) => ha.publishState(e, st);   // as server.js wires it

  // a stand-in for Home Assistant: listens to discovery + state, sends commands
  const seen = new Map();
  const hass = mqtt.connect(`mqtt://127.0.0.1:${port}`);
  await new Promise((r) => hass.once('connect', r));
  hass.subscribe(['homeassistant/#', 'heimauto/#']);
  hass.on('message', (topic, payload) => seen.set(topic, payload.toString()));

  t.after(async () => {
    await ha.disconnect();
    await new Promise((r) => hass.end(true, {}, r));
    await new Promise((r) => server.close(r));
    await new Promise((r) => aedes.close(r));
  });

  await ha.connect({ host: '127.0.0.1', port });
  assert.equal(ha.connected, true);

  // 1. discovery reached "Home Assistant"
  await waitFor(() => seen.has('homeassistant/light/heimauto/light_1a_0_0/config'));
  const cfg = JSON.parse(seen.get('homeassistant/light/heimauto/light_1a_0_0/config'));
  assert.equal(cfg.command_topic, 'heimauto/light_1a_0_0/set');
  await waitFor(() => seen.has('homeassistant/cover/heimauto/cover_19_0_0/config'));
  await waitFor(() => seen.has('homeassistant/binary_sensor/heimauto/input_1a_0_6/config'));
  assert.equal(seen.get('heimauto/status'), 'online');

  // 2. a command from Home Assistant switches the relay on the bus
  hass.publish('heimauto/light_1a_0_0/set', 'ON');
  await waitFor(() => sent.length > 0);
  assert.deepEqual(sent.at(-1), { M: 0x1a, sub: 0, val: 0x01 });
  await waitFor(() => seen.get('heimauto/light_1a_0_0/state') === 'ON');

  // 3. a cover command from Home Assistant
  hass.publish('heimauto/cover_19_0_0/set', 'CLOSE');
  await waitFor(() => sent.some((s) => s.M === 0x19));
  assert.deepEqual(sent.at(-1), { M: 0x19, sub: 0, val: 0x02 });
  await waitFor(() => seen.get('heimauto/cover_19_0_0/state') === 'closing');

  // 4. a real input change is reported to Home Assistant
  bridge.noteInput(0x1a, 0, 0x00, 0x40);
  await waitFor(() => seen.get('heimauto/input_1a_0_6/state') === 'ON');
  bridge.noteInput(0x1a, 0, 0x40, 0x00);
  await waitFor(() => seen.get('heimauto/input_1a_0_6/state') === 'OFF');

  // 5. Home Assistant restarting re-triggers the discovery
  seen.delete('homeassistant/light/heimauto/light_1a_0_0/config');
  hass.publish('homeassistant/status', 'online');
  await waitFor(() => seen.has('homeassistant/light/heimauto/light_1a_0_0/config'));
});

test('die Lüftung erscheint als fan und lässt sich stufenweise stellen', async (t) => {
  const { readFileSync } = await import('node:fs');
  const { RuleBase } = await import('../src/hrb.js');
  const { deriveEntities, mergeOverrides } = await import('../src/entities.js');
  const { LABEL_SEED } = await import('../src/moduleinfo.js');
  const rb = RuleBase.fromBuffer(readFileSync(new URL('../../RouleBase.hrb', import.meta.url)));
  const fan = mergeOverrides(deriveEntities(rb, { labels: LABEL_SEED }), {}, { labels: LABEL_SEED })
    .find((e) => e.id === 'level_1c_0');

  const { aedes, server, port } = await startBroker();
  const sent = [];
  const bridge = new Bridge({ queueOutput: (M, sub, val) => sent.push({ M, sub, val }) });
  bridge.setEntities([fan]);
  const ha = new HaMqtt(bridge);
  ha.setEntities([fan]);
  bridge.onState = (e, st) => ha.publishState(e, st);

  const seen = new Map();
  const hass = mqtt.connect(`mqtt://127.0.0.1:${port}`);
  await new Promise((r) => hass.once('connect', r));
  hass.subscribe(['homeassistant/#', 'heimauto/#']);
  hass.on('message', (topic, payload) => seen.set(topic, payload.toString()));
  t.after(async () => {
    await ha.disconnect();
    await new Promise((r) => hass.end(true, {}, r));
    await new Promise((r) => server.close(r));
    await new Promise((r) => aedes.close(r));
  });

  await ha.connect({ host: '127.0.0.1', port });
  await waitFor(() => seen.has('homeassistant/fan/heimauto/level_1c_0/config'));
  const cfg = JSON.parse(seen.get('homeassistant/fan/heimauto/level_1c_0/config'));
  assert.equal(cfg.name, 'Lüftung');
  assert.equal(cfg.speed_range_min, 1);
  assert.equal(cfg.speed_range_max, 15, '15 Stufen über null');
  assert.equal(cfg.percentage_command_topic, 'heimauto/level_1c_0/set_percentage');
  assert.equal(cfg.device.model, 'HomeBus-Analog V1.3', 'Hardwaretyp aus der ModulListe');

  // Home Assistant stellt Stufe 8 -> Register 0x88 + LED-Muster
  hass.publish('heimauto/level_1c_0/set_percentage', '8');
  await waitFor(() => sent.some((s) => s.M === 0x1c && s.val === 0x88));
  await waitFor(() => seen.get('heimauto/level_1c_0/percentage') === '8');
  assert.equal(bridge.getByte(0x31, 1), 0x3f, 'die Stufen-LEDs sind mitgeschrieben');

  hass.publish('heimauto/level_1c_0/set', 'OFF');
  await waitFor(() => sent.some((s) => s.M === 0x1c && s.val === 0x00));
  await waitFor(() => seen.get('heimauto/level_1c_0/state') === 'OFF');
});

test('disabling an entity removes it from Home Assistant', async (t) => {
  const { aedes, server, port } = await startBroker();
  const bridge = new Bridge({ queueOutput: () => {} });
  const ha = new HaMqtt(bridge);
  const seen = new Map();
  const hass = mqtt.connect(`mqtt://127.0.0.1:${port}`);
  await new Promise((r) => hass.once('connect', r));
  hass.subscribe('homeassistant/#');
  hass.on('message', (topic, payload) => seen.set(topic, payload.toString()));
  t.after(async () => {
    await ha.disconnect();
    await new Promise((r) => hass.end(true, {}, r));
    await new Promise((r) => server.close(r));
    await new Promise((r) => aedes.close(r));
  });

  bridge.setEntities(ENT);
  ha.setEntities(ENT);
  bridge.onState = (e, st) => ha.publishState(e, st);
  await ha.connect({ host: '127.0.0.1', port });
  await waitFor(() => seen.get('homeassistant/light/heimauto/light_1a_0_0/config'));

  const off = ENT.map((e) => (e.id === 'light_1a_0_0' ? { ...e, enabled: false } : e));
  bridge.setEntities(off);
  ha.setEntities(off);
  ha.publishDiscovery();
  await waitFor(() => seen.get('homeassistant/light/heimauto/light_1a_0_0/config') === '');
});
