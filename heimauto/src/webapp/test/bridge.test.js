// The bridge is what makes Home Assistant the orchestrator: a HA command has to
// become a correct HomeBus output byte, and an input report has to become an
// entity state — without the rule base running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';
import { buildOutputMulti } from '../src/homebus.js';

function setup(entities) {
  const sent = [];
  const b = new Bridge({ queueOutput: (M, sub, val) => sent.push({ M, sub, val }), tickMs: 10 });
  b.setEntities(entities);
  return { b, sent };
}

const RELAY = { id: 'light_1a_0_0', kind: 'light', module: 0x1a, sub: 0, bit: 0, name: 'HWR Licht' };
const RELAY2 = { id: 'switch_1a_0_3', kind: 'switch', module: 0x1a, sub: 0, bit: 3, name: 'Zweites Relais' };
const COVER = { id: 'cover_19_0_0', kind: 'cover', module: 0x19, sub: 0, bitDir: 0, bitRun: 1, travelSec: 1, name: 'Rolladen' };
const DIMMER = { id: 'light_11_dim', kind: 'dimmer', module: 0x11, levelSub: 3, cmdSub: 4, levelMax: 0x40, name: 'Küche' };
const BUTTON = { id: 'input_1a_0_6', kind: 'button', module: 0x1a, sub: 0, bit: 6, name: 'Taster' };

test('switching one relay produces the live-verified frame', () => {
  const { b, sent } = setup([RELAY]);
  b.command('light_1a_0_0', 'ON');
  assert.deepEqual(sent.at(-1), { M: 0x1a, sub: 0, val: 0x01 });
  // exactly the frame that was verified on the real plant
  assert.equal(buildOutputMulti(0x1a, [{ sub: 0, val: 0x01 }]).toString('hex'), 'e51a000101');
  b.command('light_1a_0_0', 'OFF');
  assert.deepEqual(sent.at(-1), { M: 0x1a, sub: 0, val: 0x00 });
});

test('a second relay on the same byte does not clear the first', () => {
  const { b, sent } = setup([RELAY, RELAY2]);
  b.command('light_1a_0_0', 'ON');
  b.command('switch_1a_0_3', 'ON');
  assert.equal(sent.at(-1).val, 0x09, 'bit0 must survive writing bit3');
  b.command('switch_1a_0_3', 'OFF');
  assert.equal(sent.at(-1).val, 0x01, 'bit0 still on');
});

test('toggle and state readback', () => {
  const { b } = setup([RELAY]);
  assert.equal(b.stateOf(RELAY).state, 'OFF');
  b.command('light_1a_0_0', 'toggle');
  assert.equal(b.stateOf(RELAY).state, 'ON');
  b.command('light_1a_0_0', 'toggle');
  assert.equal(b.stateOf(RELAY).state, 'OFF');
});

test('an input report becomes a binary_sensor state, only on change', () => {
  const { b } = setup([BUTTON]);
  const seen = [];
  b.onState = (e, st) => seen.push([e.id, st.state]);
  b.noteInput(0x1a, 0, undefined, 0x00);      // first report seeds the state
  b.noteInput(0x1a, 0, 0x00, 0x40);            // button pressed
  b.noteInput(0x1a, 0, 0x40, 0x00);            // released
  b.noteInput(0x1a, 0, 0x00, 0x02);            // a different bit: no button event
  assert.deepEqual(seen, [['input_1a_0_6', 'OFF'], ['input_1a_0_6', 'ON'], ['input_1a_0_6', 'OFF']]);
});

test('the dimmer sends level + apply command, HA brightness 0..255 -> 0..0x40', () => {
  const { b, sent } = setup([DIMMER]);
  b.command('light_11_dim', { state: 'ON', brightness: 255 });
  assert.deepEqual(sent.slice(-2), [{ M: 0x11, sub: 3, val: 0x40 }, { M: 0x11, sub: 4, val: 0x30 }]);
  b.command('light_11_dim', { state: 'ON', brightness: 128 });
  assert.equal(sent.at(-2).val, 0x20, 'half brightness = 0x20');
  b.command('light_11_dim', { state: 'OFF' });
  assert.deepEqual(sent.slice(-2), [{ M: 0x11, sub: 3, val: 0x00 }, { M: 0x11, sub: 4, val: 0x30 }]);
  assert.equal(b.stateOf(DIMMER).state, 'OFF');
});

test('"on" without brightness goes to full level', () => {
  const { b, sent } = setup([DIMMER]);
  b.command('light_11_dim', 'ON');
  assert.equal(sent.at(-2).val, 0x40);
  assert.equal(b.stateOf(DIMMER).brightness, 255);
});

test('a cover starts the motor with direction + run bit in ONE byte', () => {
  const { b, sent } = setup([COVER]);
  b.command('cover_19_0_0', 'CLOSE');
  assert.deepEqual(sent.at(-1), { M: 0x19, sub: 0, val: 0x02 }, 'dir=0 (down), run=1');
  b.command('cover_19_0_0', 'STOP');
  assert.deepEqual(sent.at(-1), { M: 0x19, sub: 0, val: 0x00 }, 'stop clears both bits');
  b.command('cover_19_0_0', 'OPEN');
  assert.deepEqual(sent.at(-1), { M: 0x19, sub: 0, val: 0x03 }, 'dir=1 (up), run=1');
});

test('the bridge owns the run time and stops the motor itself', async () => {
  // The modules have no end-position feedback: the original PC master stopped
  // them when its ShortTimer expired. travelSec = 1 s here.
  const { b, sent } = setup([COVER]);
  const states = [];
  b.onState = (e, st) => states.push(st.state);
  b.start();
  b.command('cover_19_0_0', 'CLOSE');
  assert.equal(b.coverState(COVER).state, 'closing');
  await new Promise((r) => setTimeout(r, 1400));
  b.stop();
  assert.deepEqual(sent.at(-1), { M: 0x19, sub: 0, val: 0x00 }, 'stop frame was sent');
  assert.equal(b.coverState(COVER).position, 0, 'position reached the target');
  assert.equal(b.coverState(COVER).state, 'closed');
  assert.ok(states.includes('closing') && states.at(-1) === 'closed');
});

test('set_position stops halfway', async () => {
  const { b, sent } = setup([COVER]);
  b.start();
  b.command('cover_19_0_0', 'CLOSE');                 // learn position 0
  await new Promise((r) => setTimeout(r, 1300));
  b.command('cover_19_0_0', { position: 50 });
  assert.equal(b.coverState(COVER).state, 'opening');
  await new Promise((r) => setTimeout(r, 700));
  b.stop();
  const pos = b.coverState(COVER).position;
  assert.ok(pos >= 45 && pos <= 55, `stopped near 50 % (was ${pos})`);
  assert.deepEqual(sent.at(-1), { M: 0x19, sub: 0, val: 0x00 });
});

test('state survives a restart (shadow + cover position persisted)', () => {
  const { b } = setup([RELAY, RELAY2, COVER]);
  b.command('light_1a_0_0', 'ON');
  b.covers.get('cover_19_0_0').position = 25;
  b.covers.get('cover_19_0_0').unknown = false;
  const snap = JSON.parse(JSON.stringify(b.snapshot()));

  const fresh = setup([RELAY, RELAY2, COVER]);
  fresh.b.restore(snap);
  assert.equal(fresh.b.stateOf(RELAY).state, 'ON', 'relay shadow restored');
  assert.equal(fresh.b.coverState(COVER).position, 25);
  // and the other relay of that byte is still switched correctly
  fresh.b.command('switch_1a_0_3', 'ON');
  assert.equal(fresh.sent.at(-1).val, 0x09);
});

test('an input entity cannot be commanded', () => {
  const { b } = setup([BUTTON]);
  assert.throws(() => b.command('input_1a_0_6', 'ON'), /cannot be commanded/);
  assert.throws(() => b.command('does_not_exist', 'ON'), /unknown entity/);
});

test('disabled entities are neither commandable nor reported', () => {
  const { b } = setup([{ ...RELAY, enabled: false }, BUTTON]);
  assert.throws(() => b.command('light_1a_0_0', 'ON'), /unknown entity/);
});
