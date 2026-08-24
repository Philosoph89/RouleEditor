import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Deframer, TimeBase, TimerTable, TIME_EVENT_KEY, LT_RELOAD, RX_HARD_CAP } from '../src/homebus.js';

test('deframer enforces the verified sync rule buf[1] === ~buf[0]', () => {
  const d = new Deframer(1024);
  // bad sync: 0xAA followed by something that is not 0x55
  d.push(Buffer.from([0xaa, 0x00, 0x01, 0x02]));
  assert.ok(d.resyncs > 0, 'dropped bytes while resyncing');
});

test('deframer accepts a correctly synced header and scans 2-byte pairs', () => {
  const d = new Deframer(1024);
  // header 0xAA,0x55 (0x55 === ~0xAA & 0xFF), then one class-B pair (x===15)
  const frames = d.push(Buffer.from([0xaa, 0x55, 0x0f, 0x0f]));
  assert.equal(frames.length, 1, 'one frame extracted');
  const f = frames[0];
  assert.equal(f.bytes[0], 0xaa);
  assert.equal(f.bytes[1], 0x55);
  assert.equal(f.classes[0].cls, 'B', 'x===15 is class B');
});

test('deframer classifies command classes per (byte & 0x1f)', () => {
  const mk = (x) => {
    const d = new Deframer(1024);
    // pair: buf[2]=x (with matching 0x20/0x40 flags), buf[3]=x
    const f = d.push(Buffer.from([0x00, 0xff, x, x, 0x0f, 0x0f]));
    return f.length ? f[0].classes[0].cls : null;
  };
  assert.equal(mk(0x00), 'A', 'x=0 -> A');
  assert.equal(mk(0x0e), 'A', 'x=14 -> A');
  assert.equal(mk(0x0f), 'B', 'x=15 -> B');
  assert.equal(mk(0x10), 'C', 'x=16 -> C');
  assert.equal(mk(0x1f), 'A', 'x=31 -> A');
});

test('deframer restarts on buffer overrun (verified behaviour)', () => {
  const d = new Deframer(8);
  for (let i = 0; i < 20; i++) d.pushByte(0x41);
  assert.ok(d.overruns > 0, 'overrun counted');
  assert.ok(d.count <= 8, 'buffer stays within the configured limit');
});

test('deframer hard cap is 2048 bytes', () => {
  const d = new Deframer(99999);
  assert.equal(d.limit, RX_HARD_CAP);
});

test('time base emits event key 8 on minute change', () => {
  const tb = new TimeBase();
  tb.tick(new Date(2020, 0, 1, 12, 30, 0));
  assert.deepEqual(tb.drainQueue(), [], 'first sample only primes lastMinute');
  tb.tick(new Date(2020, 0, 1, 12, 31, 0));
  assert.deepEqual(tb.drainQueue(), [TIME_EVENT_KEY], 'minute change enqueues key 8');
});

test('time base ShortTimer every 2nd tick, LongTimer on reload boundary', () => {
  const tb = new TimeBase();
  const now = new Date(2020, 0, 1, 0, 0, 0);
  const first = tb.tick(now);
  assert.equal(first.shortTimer, true, 'counter 0 -> short timer');
  assert.equal(first.longTimer, true, 'counter 0 -> long timer, reloads');
  assert.equal(tb.counter, LT_RELOAD - 1, 'counter reloaded to 240 then decremented');
  const second = tb.tick(now);
  assert.equal(second.shortTimer, false, 'odd counter -> no short timer');
});

test('timer table is id-addressed and caps at 31 entries', () => {
  const t = new TimerTable();
  t.set(0x1234, 5);
  assert.equal(t.get(0x1234), 5);
  assert.equal(t.get(0x9999), 0, 'unknown id reads 0');
  for (let i = 0; i < 40; i++) t.set(0x2000 + i, 1);
  assert.ok(t.list().length <= 31, 'table capped at 0x1F entries');
  const expired = t.tick();
  assert.ok(expired.length > 0, 'timers expire on tick');
});
