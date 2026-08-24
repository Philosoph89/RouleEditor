// Regression: an output pulse must survive until the module is ACTUALLY polled.
// The poller is round-robin, so with 25 modules at 50ms a module's turn only
// comes every 1250ms. A wall-clock pulse window shorter than that expired
// before the frame ever reached the wire (light did not switch).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Poller, buildOutput, buildPoll } from '../src/homebus.js';

function makePoller(nAddrs) {
  const sent = [];
  const p = new Poller();
  p.writeFn = (f) => { sent.push(f.toString('hex')); };
  p.addrs = Array.from({ length: nAddrs }, (_, i) => 0x10 + i);
  p.idx = 0;
  return { p, sent };
}

// drive `ticks` poll slots manually (no timers involved)
async function drive(p, ticks) { for (let i = 0; i < ticks; i++) await p._tick(); }

test('pulseOutput survives a full round-robin cycle', async () => {
  const { p, sent } = makePoller(25);
  const M = 0x1a;
  const frame = buildOutput(M, 0, 0x01);
  p.pulseOutput(M, frame, 2);
  // 0x1A is the 11th address -> its turn only comes on slot 10 of each cycle.
  await drive(p, 25 * 3);
  const outs = sent.filter((h) => h === frame.toString('hex'));
  assert.equal(outs.length, 2, 'output frame must be written exactly twice');
  // afterwards the module is polled normally again
  assert.ok(sent.at(-1) !== frame.toString('hex'), 'override must be cleared');
  assert.ok(sent.includes(buildPoll(M).toString('hex')), 'normal poll resumes');
});

test('pulse counts polls of THAT module, not global ticks', async () => {
  const { p, sent } = makePoller(25);
  const M = 0x28; // last address of the list -> polled once per 25 ticks
  const frame = buildOutput(M, 0, 0x01);
  p.pulseOutput(M, frame, 1);
  await drive(p, 24);            // 0x28 not reached yet (idx 0..23 -> 0x10..0x27)
  assert.equal(sent.filter((h) => h === frame.toString('hex')).length, 0,
    'nothing sent before the module’s turn');
  await drive(p, 1);             // now its turn
  assert.equal(sent.filter((h) => h === frame.toString('hex')).length, 1,
    'sent exactly on its turn');
});

test('manual setOverride is NOT consumed by polling', async () => {
  const { p, sent } = makePoller(4);
  const M = 0x11;
  const frame = buildOutput(M, 0, 0x01);
  p.setOverride(M, frame);       // manual override: must persist
  await drive(p, 4 * 3);
  assert.equal(sent.filter((h) => h === frame.toString('hex')).length, 3,
    'manual override stays active every cycle');
});

// The original polls ALL modules in ONE write per cycle (~110 ms), which is why
// it reacts within ~0.2 s. Verified verbatim against the original event log:
//   "EF 10 0F 0F FF 00 0F 0F FF 00 0F 0F FF 00 0F 0F"  (module + 3x padding)
test('buildBurst matches the original burst layout', () => {
  const { p } = makePoller(2);           // 0x10, 0x11
  const { buffer } = p.buildBurst();
  assert.equal(buffer.length, 2 * 16, 'each module contributes 16 bytes');
  assert.equal(buffer.subarray(0, 16).toString('hex'),
    'ef100f0f' + 'ff000f0f'.repeat(3), 'module 0x10 segment + padding');
  assert.equal(buffer.subarray(16, 32).toString('hex'),
    'ee110f0f' + 'ff000f0f'.repeat(3), 'module 0x11 segment + padding');
});

test('a pending output rides along in the very next burst', async () => {
  const { p, sent } = makePoller(25);
  const M = 0x1a;
  const frame = buildOutput(M, 0, 0x01);
  p.pulseOutput(M, frame, 2);
  await p._burst();                       // ONE cycle is enough to reach 0x1A
  assert.ok(sent[0].includes(frame.toString('hex')),
    'output frame is part of the first burst — no round-robin wait');
  await p._burst();                       // second pulse repetition
  await p._burst();                       // back to normal poll
  assert.ok(!sent[2].includes(frame.toString('hex')), 'override cleared after 2 bursts');
  assert.ok(sent[2].includes(buildPoll(M).toString('hex')), 'normal poll resumed');
});
