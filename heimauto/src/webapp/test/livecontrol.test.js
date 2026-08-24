// Input detection from the RX stream. Modules idle at "0F 0F" ("nothing to
// report") and announce a changed sub-byte only briefly. Taking the most
// frequent pair per window dropped those single reports — the kitchen button on
// module 0x12 never produced an event.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveController } from '../src/livecontrol.js';

function make() {
  const lc = new LiveController(null);
  lc.setModules([0x11, 0x12, 0x1a]);
  const seen = [];
  lc._process = (M, sub, prev, val) => seen.push({ M, sub, prev, val });
  return { lc, seen };
}
const idle = (M) => [(~M) & 0xff, M, 0x0f, 0x0f];
const report = (M, sub, val) => {
  const ctrl = sub & 0x0f;
  return [(~M) & 0xff, M, ctrl, val, (ctrl ^ val) & 0xff];
};

test('a single report among many idle replies is not lost', () => {
  const { lc, seen } = make();
  lc.feed([...idle(0x12), ...idle(0x11), ...idle(0x1a)]);
  lc._tick();                                  // establish baseline
  seen.length = 0;
  // module 0x12 announces sub0 = 0x80 exactly once, surrounded by idle replies
  lc.feed([...idle(0x11), ...report(0x12, 0, 0x00), ...idle(0x1a)]);
  lc._tick();
  lc.feed([...idle(0x11), ...report(0x12, 0, 0x80), ...idle(0x11), ...idle(0x1a)]);
  lc._tick();
  assert.equal(seen.length, 1, 'the single change report must produce one event');
  assert.deepEqual(seen[0], { M: 0x12, sub: 0, prev: 0x00, val: 0x80 });
});

test('idle 0F0F replies never produce events', () => {
  const { lc, seen } = make();
  for (let i = 0; i < 5; i++) { lc.feed([...idle(0x11), ...idle(0x12)]); lc._tick(); }
  assert.equal(seen.length, 0);
});

test('multiple pairs in one reply are all processed (0x10 = more follow)', () => {
  const { lc, seen } = make();
  // baseline
  lc.feed([...report(0x11, 3, 0x00)]); lc._tick();
  lc.feed([...report(0x11, 4, 0x00)]); lc._tick();
  seen.length = 0;
  // one reply carrying sub3 and sub4: first ctrl has 0x10 set
  lc.feed([(~0x11) & 0xff, 0x11, 0x13, 0x40, 0x04, 0x30, 0x00]);
  lc._tick();
  assert.equal(seen.length, 2, 'both pairs must be seen');
  assert.deepEqual(seen.map((s) => [s.sub, s.val]), [[3, 0x40], [4, 0x30]]);
});

test('unknown modules are ignored', () => {
  const { lc, seen } = make();
  lc.feed([...report(0x55, 0, 0x01)]); lc._tick();
  lc.feed([...report(0x55, 0, 0x02)]); lc._tick();
  assert.equal(seen.length, 0);
});
