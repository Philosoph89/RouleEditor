// End-to-end semantics of the HWR shutter (module 0x19, event key 0xC87) against
// the REAL rule base. The original logic:
//   press:   00.0.7==1 ; 19.7.0:=1 ; 19.0.0:=0 ; 19.0.1:=1 ; LST9:=30.0
//   release: 00.0.7==0 ; LST9=<29.0 ; 19.0.1:=0 ; 19.0.0:=0
//   expiry:  (event key 0xC89) 19.0.1:=0 ; 19.0.0:=0
// So a HELD button (>=1 s) stops on release, while a SHORT tap keeps the shutter
// running until ShortTimer #9 expires 30 s later.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RuleBase } from '../src/hrb.js';
import { Interpreter } from '../src/interpreter.js';

const KEY_DOWN = (0x19 << 7) | 7;   // 0xC87  input 19.0.7
const KEY_EXP = (0x19 << 7) | 9;    // 0xC89  ShortTimer #9 expiry
const CTX = 0x00;

function setup() {
  const rb = RuleBase.fromBuffer(readFileSync(new URL('../../RouleBase.hrb', import.meta.url)));
  const it = new Interpreter(rb);
  it.state.register(CTX); it.state.register(0x19);
  return it;
}
const shutter = (it) => it.state.getSubByte(0x19, 0) & 0x03;   // bit0 up / bit1 down
const timer9 = (it) => it.state.stTable.get(KEY_EXP);

function press(it) { it.state.setSubByte(CTX, 0, 0x80); it.processEventKey(KEY_DOWN); }
function release(it) { it.state.setSubByte(CTX, 0, 0x00); it.processEventKey(KEY_DOWN); }

test('press starts the shutter and loads ShortTimer #9 with 30 s', () => {
  const it = setup();
  press(it);
  assert.equal(shutter(it), 0x02, 'bit1 set = shutter runs down');
  assert.equal(timer9(it), 60, 'LST9 = 60 counts = 30 s at 0.5 s per count');
});

test('SHORT tap keeps running, then the expiring timer stops it', () => {
  const it = setup();
  press(it);
  release(it);                       // released immediately: LST9 still 60
  assert.equal(shutter(it), 0x02, 'a short tap must NOT stop the shutter');
  // 60 ShortTimer maintenance steps = 30 s
  let expired = [];
  for (let i = 0; i < 60; i++) expired = it.tickShortTimers();
  assert.ok(expired.length > 0, 'timer expiry fires its event key');
  assert.equal(expired[0].eventKey, KEY_EXP, 'expiry event key == timer id 0xC89');
  assert.equal(shutter(it), 0x00, 'shutter stopped by the expiry rule');
});

test('HELD button (>=1 s) stops on release', () => {
  const it = setup();
  press(it);
  it.tickShortTimers(); it.tickShortTimers();   // 1 s elapsed -> LST9 = 58
  assert.equal(timer9(it), 58);
  release(it);                                   // 58 =< 58 holds -> stop
  assert.equal(shutter(it), 0x00, 'released after >=1 s stops immediately');
});

test('the run time is definable: changing LST9 changes the runtime', () => {
  const it = setup();
  press(it);
  it.state.stTable.set(KEY_EXP, 20);            // 10 s instead of 30 s
  let expired = [];
  for (let i = 0; i < 20; i++) expired = it.tickShortTimers();
  assert.equal(expired[0]?.eventKey, KEY_EXP);
  assert.equal(shutter(it), 0x00, 'stops after the configured time');
});

// Timer numbers 0..7 are STOPWATCHES: their ids alias sub-0 event keys, where
// the physical buttons live. Only 8..15 are expiry timers (sub 1 = the rule
// base's "Ablaufevent" range). Firing a stopwatch ran a random button handler —
// the kitchen light's LST0 has id 0x900, the shutter-UP key of module 0x12, so
// switching the light off stopped the kitchen-east shutter.
test('a stopwatch timer (nr < 8) fires no event', () => {
  const it = setup();
  it.state.register(0x12);
  it.state.setSubByte(0x12, 0, 0x02);            // shutter running (down)
  it.state.stTable.set(0x900, 1);                // LST0 of the kitchen light
  const fired = it.tickShortTimers();             // expires now
  assert.equal(fired.length, 0, 'no rules may run for a stopwatch');
  assert.equal(it.state.getSubByte(0x12, 0), 0x02, 'the shutter must keep running');
});

test('an expiry timer (nr >= 8) still fires its Ablaufevent', () => {
  const it = setup();
  it.state.register(0x19);
  it.state.setSubByte(0x19, 0, 0x02);            // HWR shutter running
  it.state.stTable.set(KEY_EXP, 1);              // LST9, id 0xC89
  const fired = it.tickShortTimers();
  assert.ok(fired.length > 0, 'the Ablaufevent must run');
  assert.equal(it.state.getSubByte(0x19, 0) & 0x03, 0x00, 'shutter stopped by the timer');
});
