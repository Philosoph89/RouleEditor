// The kitchen dimmer (event key 0x907 = module 0x12 bit 7) drives module 0x11
// with TWO bytes per action: a level byte (11.3) and a command byte (11.4).
// A per-module single-frame override dropped all but the last column, which made
// "short press = on" and "release stops dimming" fail while "short press = off"
// only appeared to work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RuleBase } from '../src/hrb.js';
import { Interpreter } from '../src/interpreter.js';
import { Poller, buildOutput, buildOutputMulti } from '../src/homebus.js';

const KEY = (0x12 << 7) | 7;
const TID = (KEY & 0x7ff0) | 0;          // LST0 timer id

function setup() {
  const rb = RuleBase.fromBuffer(readFileSync(new URL('../../RouleBase.hrb', import.meta.url)));
  const it = new Interpreter(rb);
  for (const a of [0x00, 0x11, 0x12]) it.state.register(a);
  return it;
}
// returns coalesced [{module,sub,value}] like LiveController does
function fire(it, pressed) {
  it.state.setSubByte(0x00, 0, pressed ? 0x80 : 0x00);
  const finals = new Map();
  for (const f of it.processEventKey(KEY)) {
    for (const c of f.changes) finals.set((c.module << 4) | c.sub, { module: c.module, sub: c.sub });
  }
  return [...finals.values()].map(({ module, sub }) => ({ module, sub, value: it.state.getSubByte(module, sub) }));
}

test('short press turns the light ON (level + command byte)', () => {
  const it = setup();
  fire(it, true);
  const outs = fire(it, false);          // released before 1.5 s
  const m11 = outs.filter((o) => o.module === 0x11);
  assert.deepEqual(m11.map((o) => [o.sub, o.value]), [[3, 0x40], [4, 0x30]],
    'level 11.3=0x40 AND command 11.4=0x30 must both be produced');
});

test('second short press turns it OFF', () => {
  const it = setup();
  fire(it, true); fire(it, false);       // on
  fire(it, true);
  const outs = fire(it, false);          // off
  const m11 = outs.filter((o) => o.module === 0x11);
  assert.deepEqual(m11.map((o) => [o.sub, o.value]), [[3, 0x00], [4, 0x30]]);
});

test('release after >1.5 s stops the dim ramp (11.4 = 0x10)', () => {
  const it = setup();
  fire(it, true);
  assert.equal(it.state.stTable.get(TID), 3, 'LST0 = 3 counts = 1.5 s');
  for (let i = 0; i < 4; i++) it.tickShortTimers();   // 2 s
  const outs = fire(it, false);
  const cmd = outs.find((o) => o.module === 0x11 && o.sub === 4);
  assert.ok(cmd, 'a command byte must be produced on release');
  assert.equal(cmd.value, 0x10, 'stop command 11.4 = 0x10');
});

test('both columns of one module leave in ONE segment', async () => {
  const p = new Poller();
  const sent = [];
  p.writeFn = (f) => { sent.push(f.toString('hex')); };
  p.addrs = [0x11];
  p.queueOutput(0x11, 3, 0x40);
  p.queueOutput(0x11, 4, 0x30);          // same module -> must NOT overwrite
  await p._burst();
  const expect = buildOutputMulti(0x11, [{ sub: 3, val: 0x40 }, { sub: 4, val: 0x30 }]).toString('hex');
  assert.ok(sent[0].startsWith(expect), `burst must carry both columns (${expect})`);
});

test('single-column output is byte-identical to the verified frame', () => {
  // live-verified relay frame + the original log's (10.F) <- 10
  assert.equal(buildOutput(0x1a, 0, 0x01).toString('hex'), 'e51a000101');
  assert.equal(buildOutput(0x10, 0xf, 0x10).toString('hex'), 'ef101f100f');
});

test('a sent column never rides along with the next action', async () => {
  const p = new Poller();
  const sent = [];
  p.writeFn = (f) => { sent.push(f.toString('hex')); };
  p.addrs = [0x11];
  p.queueOutput(0x11, 3, 0x40);            // level from a previous action
  p.queueOutput(0x11, 4, 0x30);
  await p._burst();                        // both sent
  p.queueOutput(0x11, 4, 0x10);            // later action: stop only
  await p._burst();
  const seg = sent[1];
  assert.ok(seg.includes('0410') || seg.includes('8410') || seg.includes('a410'),
    'stop command must be in the second segment');
  assert.ok(!seg.includes('40'), `stale level 0x40 must NOT be re-sent (${seg})`);
});
