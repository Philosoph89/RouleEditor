// HomeBus V1.2 protocol layer: RX deframer + system time base.
//
// Transcribed from the original at assembly level:
//   RX byte handler   0x00470674  (buffer append, overflow restart, high-water)
//   frame extractor   0x004708E0  (sync check, pair scan, XOR checksum)
//   byte consumer     0x00470760  (drop N bytes from the front / resync)
//   time base         TSimulationForm.SystemTimer (0x00467F10)
//
// VERIFIED from the binary:
//   * RX buffer lives at 0x48400C, hard cap 0x7FF+1 = 2048 bytes; the soft
//     limit is the configured receive buffer size (0x474E88, DFM default 1024).
//     On overflow the buffer restarts with the current byte (index := 1) and a
//     "RxStream Buffer Overrun" error is reported.
//   * A frame needs at least 4 bytes.
//   * SYNC RULE: buf[1] === (~buf[0] & 0xFF)  — first byte plus its complement.
//     If it does not hold, exactly one byte is dropped and sync is retried.
//   * From offset 2 the payload is scanned in 2-BYTE PAIRS (p += 2) while
//     p < count-1.
//   * Command class comes from (buf[p] & 0x1F):
//        0..14, 31 -> class A (data/checksum path)
//        15        -> class B
//        16..30    -> class C
//   * Running XOR checksum accumulates (buf[p] & 0x7F) and buf[p+1].
//   * Cross-byte flag consistency is validated:
//        (buf[p-1] & 0x40) === (buf[p]   & 0x40)
//        (buf[p]   & 0x20) === (buf[p+1] & 0x20)
//     bit 0x80 of buf[p] is checked against (buf[p+2] & 0x7F).
//
// STILL OPEN (needs the real modules or a captured rx-Log.txt to confirm):
//   * the exact payload semantics of command classes B (15) and C (16..30),
//   * how a frame's total length / termination is finally decided,
//   * the poll/announce sequence and TX frame construction.
// Because of that this module reports *synchronised candidate frames* with
// their checksum state rather than pretending to fully decode every command.

export const RX_HARD_CAP = 0x800;      // 2048, the range-checked maximum
export const MIN_FRAME = 4;

export class Deframer {
  constructor(limit = 1024) {
    this.limit = Math.min(limit, RX_HARD_CAP);
    this.buf = Buffer.alloc(RX_HARD_CAP);
    this.count = 0;          // current fill (the original's index word)
    this.highWater = 0;      // 0x484820
    this.overruns = 0;
    this.resyncs = 0;
  }

  setLimit(limit) {
    this.limit = Math.max(MIN_FRAME, Math.min(Number(limit) || 1024, RX_HARD_CAP));
  }

  // RX byte handler (0x00470674).
  pushByte(b) {
    if (this.count < this.limit) {
      this.buf[this.count] = b & 0xff;
      this.count++;
      if (this.count > this.highWater) this.highWater = this.count;
    } else {
      // buffer overrun: restart with this byte
      this.overruns++;
      this.buf[0] = b & 0xff;
      this.count = 1;
    }
  }

  // Drop n bytes from the front (0x00470760).
  consume(n) {
    if (n <= 0) return;
    if (n >= this.count) { this.count = 0; return; }
    this.buf.copy(this.buf, 0, n, this.count);
    this.count -= n;
  }

  // Try to extract one synchronised frame. Returns null when more data is
  // needed, or { bytes, checksum, checksumOk, classes, flagErrors }.
  next() {
    if (this.count < MIN_FRAME) return null;

    // sync: buf[1] must be the complement of buf[0]
    if (this.buf[1] !== ((~this.buf[0]) & 0xff)) {
      this.consume(1);
      this.resyncs++;
      return null;
    }

    let chk = 0;
    const classes = [];
    const flagErrors = [];
    let p = 2;
    let end = 2;

    while (p < this.count - 1) {
      const b = this.buf[p];
      const x = b & 0x1f;
      const cls = (x <= 14 || x === 31) ? 'A' : (x === 15 ? 'B' : 'C');
      classes.push({ at: p, raw: b, x, cls });

      // running XOR checksum (class A path in the original)
      chk ^= (b & 0x7f);
      chk ^= this.buf[p + 1];

      // cross-byte flag consistency checks
      if ((this.buf[p - 1] & 0x40) !== (b & 0x40)) flagErrors.push({ at: p, bit: 0x40 });
      if ((b & 0x20) !== (this.buf[p + 1] & 0x20)) flagErrors.push({ at: p, bit: 0x20 });

      p += 2;
      end = p;
      // class B (x === 15) terminates the scan in the original's dedicated path
      if (cls === 'B') break;
    }

    if (end <= 2) return null; // nothing consumable yet

    const bytes = Buffer.from(this.buf.subarray(0, end));
    this.consume(end);
    return {
      bytes,
      hex: bytes.toString('hex'),
      checksum: chk & 0x7f,
      checksumOk: (chk & 0x7f) === 0,
      classes,
      flagErrors,
      partial: true, // command payloads not fully decoded — see module header
    };
  }

  // Feed a chunk and return all frames it yielded.
  push(chunk) {
    const out = [];
    for (const b of chunk) this.pushByte(b);
    let guard = 0;
    for (;;) {
      const before = this.count;
      const f = this.next();
      if (f) out.push(f);
      // stop when nothing was consumed (need more data) or on runaway
      if (this.count === before || this.count < MIN_FRAME || ++guard > 512) break;
    }
    return out;
  }

  stats() {
    return { count: this.count, limit: this.limit, highWater: this.highWater,
             overruns: this.overruns, resyncs: this.resyncs };
  }
}

// ---------------------------------------------------------------------------
// System time base (TSimulationForm.SystemTimer, 0x00467F10).
//
// VERIFIED behaviour per tick:
//   * GetLocalTime() is sampled into a SYSTEMTIME record.
//   * When the MINUTE differs from the previous sample, event key 8 is pushed
//     into the message queue (0x475188) — this is the DateTime/minute event.
//     The real rule base indeed starts with index entries of groupId 8.
//   * ShortTimer maintenance runs when (counter & 1) === 0  (every 2nd tick).
//   * LongTimer maintenance runs when the counter reaches 0; the counter is
//     then reloaded with 0xF0 (240) and counts down each tick.
//   * Afterwards ExecMsgList() drains the queue.
export const TIME_EVENT_KEY = 8;
export const LT_RELOAD = 0xf0;

export class TimeBase {
  constructor() {
    this.counter = 0;         // 0x474E1C
    this.lastMinute = null;
    this.queue = [];          // event keys (0x475188)
  }

  // Advance one tick. `now` is a Date (injectable for tests).
  tick(now = new Date()) {
    const events = { minuteChanged: false, shortTimer: false, longTimer: false };

    if ((this.counter & 1) === 0) events.shortTimer = true;

    const minute = now.getMinutes();
    if (this.lastMinute !== null && minute !== this.lastMinute) {
      events.minuteChanged = true;
      this.queue.push(TIME_EVENT_KEY);
    }
    this.lastMinute = minute;

    if (this.counter === 0) {
      this.counter = LT_RELOAD;
      events.longTimer = true;
    }
    this.counter = (this.counter - 1) & 0xff;

    return events;
  }

  drainQueue() {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  // SYSTEMTIME-equivalent snapshot used by the DateTime rules.
  dateTime(now = new Date()) {
    return {
      month: now.getMonth() + 1,
      day: now.getDate(),
      weekday: now.getDay(),
      hour: now.getHours(),
      minute: now.getMinutes(),
      second: now.getSeconds(),
    };
  }
}

// ---------------------------------------------------------------------------
// Timer tables (ShortTimer 0x4750E0 / LongTimer 0x475114).
//
// VERIFIED: timers are addressed by a 16-bit id, not by a plain index. The
// interpreter computes the id as (eventKey & 0x7FF0) | ((W>>24)&0xF) and looks
// it up through FUN_00460300, which walks a list of at most 0x1F (31) entries
// accumulating values until the id matches. This models that list.
export const TIMER_MAX = 0x1f;

export class TimerTable {
  constructor() { this.entries = []; } // [{ id, value }]

  set(id, value) {
    const e = this.entries.find((x) => x.id === id);
    if (e) { e.value = value; return e; }
    if (this.entries.length >= TIMER_MAX) return null; // table full, like the original
    const ne = { id: id & 0xffff, value };
    this.entries.push(ne);
    return ne;
  }

  get(id) {
    const e = this.entries.find((x) => x.id === (id & 0xffff));
    return e ? e.value : 0;
  }

  // Decrement all running timers (one maintenance step).
  tick() {
    let expired = [];
    for (const e of this.entries) {
      if (e.value > 0) {
        e.value--;
        if (e.value === 0) expired.push(e.id);
      }
    }
    return expired;
  }

  list() { return this.entries.map((e) => ({ ...e })); }
}

// ---------------------------------------------------------------------------
// Master poll (transcribed from TSimulationForm.PollNextAnnMod, 0x00467364).
//
// The HomeBus is a polled master/slave bus: the PC is master and must poll each
// module; only then does the addressed module answer. Verified live against the
// real installation on /dev/cu.usbserial-110.
//
// Poll frame for module address M (4 bytes):
//   byte0 = M XOR 0xFF                         (sync partner of byte1)
//   byte1 = M
//   byte2 = (oddParity(base) << 7) | base,  base = (M & 0x40) | 0x0F
//   byte3 = byte2                             (checksum = 0 XOR status)
// The parity bit is FUN_00467324 (x86 PF over `base`, i.e. odd parity).
function oddParity(x) {
  let c = 0;
  for (; x; x &= x - 1) c++;
  return c & 1;
}
export function buildPoll(M) {
  M &= 0xff;
  const base = (M & 0x40) | 0x0f;
  const status = ((oddParity(base) << 7) | base) & 0xff;
  return Buffer.from([(~M) & 0xff, M, status, status]);
}

// Announced-poll output frame (transcribed from PollNextAnnMod, 0x00467440..):
//   header [~M, M], then per changed sub a pair [ctrl, val] where
//   base = (M&0x40) | (val&0x20) | (sub&0x0F);  if pending: base |= 0x10;
//   ctrl = (oddParity(base)<<7) | base;   val = the output byte value.
// The 0x10 "pending output" bit and the parity bit were the pieces missing in
// the first (rejected) attempts.
// Faithful port of the master TX burst (sub_00467e00, Branch B, single column).
// Per-module segment = [~M, M, ctrl, val, checksum]
//   base     = (M&0x40) | (val&0x20) | col       (col==0xF or "more follow" would add 0x10)
//   bVar5    = runningXOR(=0) ^ base ^ val        // last column
//   ctrl     = base | (bVar5 & 0x80)              // bit7 = XOR-checksum bit
//   checksum = (bVar5 & 0x7f) | (val & 0x80)      // trailing local_d byte
export function buildOutput(M, sub, val, { more = false } = {}) {
  return buildOutputMulti(M, [{ sub, val }], { more });
}

// Multi-column output segment, faithful to the master burst (sub_00467e00,
// Branch B). The original walks the module's change-flag word from bit 0 upwards
// and appends one [ctrl,val] pair per changed column, then ONE trailing XOR
// checksum for the whole segment:
//   base   = (M&0x40) | (val&0x20) | col     ( |0x10 if more columns follow
//                                              or col == 0xF )
//   not last column:  ctrl = (oddParity(base)<<7) | base
//                     running ^= ctrl ^ val
//   last column:      b    = running ^ base ^ val
//                     ctrl = base | (b & 0x80)
//                     running = (b & 0x7f) | (val & 0x80)
//   segment = [~M, M, ctrl1, val1, ... ctrlN, valN, running]
// This matters for real devices: the kitchen dimmer needs the level byte (11.3)
// and the command byte (11.4) in ONE segment — sending only the last one leaves
// the dimmer without a level (light stays off) or drops the stop command.
export function buildOutputMulti(M, columns, { more = false } = {}) {
  // ascending column order, exactly like the change-flag scan in the original
  const cols = columns
    .map((c) => ({ col: c.sub & 0x0f, val: c.val & 0xff }))
    .sort((a, b) => a.col - b.col);
  const bytes = [(~M) & 0xff, M & 0xff];
  let running = 0;                                  // local_d
  // Bit 0x40 of a ctrl byte mirrors bit 0x40 of the byte IMMEDIATELY BEFORE it —
  // the module address for the first pair, the previous pair's VALUE for every
  // following pair. (Same rule the RX deframer enforces:
  // (buf[p-1] & 0x40) === (buf[p] & 0x40).) Verified byte-exact against the
  // original: level 0x40 has bit 6 set, so the next ctrl is E4, not A4 —
  // "EE 11 93 40 E4 30 07". Getting this wrong made the dimmer ignore the
  // set-level command and keep ramping.
  let prev = M & 0xff;
  cols.forEach((c, i) => {
    const last = i === cols.length - 1;
    let base = ((prev & 0x40) | (c.val & 0x20) | c.col) & 0xff;
    if (!last || more || c.col === 0x0f) base |= 0x10;
    if (last && !more) {
      const b = (running ^ base ^ c.val) & 0xff;
      bytes.push((base | (b & 0x80)) & 0xff, c.val);
      running = ((b & 0x7f) | (c.val & 0x80)) & 0xff;
    } else {
      const ctrl = ((oddParity(base) << 7) | base) & 0xff;
      bytes.push(ctrl, c.val);
      running = (running ^ ctrl ^ c.val) & 0xff;
    }
    prev = c.val;                                   // next ctrl mirrors this byte
  });
  bytes.push(running);
  return Buffer.from(bytes);
}

// Round-robin poller. Calls writeFn(pollFrame) for one address per tick.
// Original master cycle: all modules in one burst every ~110 ms (measured in
// re/captures/Hochlauf_2026-08-18_original-evlog.txt — every module reappears
// every ~110 ms, all segments share one timestamp).
export const BURST_CYCLE_MS = 110;
// Turnaround padding the original appends after each module segment: three
// dummy polls to address 0x00.
const BURST_PAD = Buffer.from([0xff, 0x00, 0x0f, 0x0f]);

export class Poller {
  constructor() {
    this.timer = null;
    this.addrs = [];
    this.idx = 0;
    this.intervalMs = BURST_CYCLE_MS;
    this.mode = 'burst';
    this.writeFn = null;
    this.onPoll = null;     // optional callback(addr, frame)
    this.overrides = new Map(); // M -> raw frame (manual override, /api/bus/output)
    // Pending outputs per module: M -> Map<column, value>. The original keeps
    // the values plus a change-flag word in the module record and builds ONE
    // segment per module per burst, covering ALL changed columns. Keying only by
    // module (as a single frame) would drop every column but the last — which
    // broke the kitchen dimmer (level byte + command byte).
    this.pending = new Map();
  }

  get running() { return Boolean(this.timer); }

  // mode 'burst' (default, = original behaviour): ALL modules are polled in ONE
  // write per cycle and the cycle repeats every `intervalMs` (~110 ms in the
  // original). mode 'roundrobin': one module per tick (much slower reaction —
  // 25 modules * 50 ms = 1.25 s per module — kept for diagnostics).
  start(writeFn, addrs, intervalMs = BURST_CYCLE_MS, { mode = 'burst' } = {}) {
    this.stop();
    this.writeFn = writeFn;
    this.addrs = (addrs && addrs.length) ? addrs.slice() : defaultPollRange();
    this.mode = mode === 'roundrobin' ? 'roundrobin' : 'burst';
    if (this.mode === 'burst') {
      // One cycle transmits addrs.length*16 bytes and every module answers.
      // Keep the line below ~40% duty so replies never collide with the next
      // burst (115200 baud = 11520 B/s).
      const burstBytes = this.addrs.length * 16;
      const floorMs = Math.ceil((burstBytes / 11520) * 1000 * 2.5);
      this.intervalMs = Math.max(floorMs, Number(intervalMs) || BURST_CYCLE_MS);
    } else {
      this.intervalMs = Math.max(5, Number(intervalMs) || 50);
    }
    this.idx = 0;
    const step = this.mode === 'burst' ? () => this._burst() : () => this._tick();
    this.timer = setInterval(step, this.intervalMs);
  }

  // Build the whole cycle exactly like the original's master burst: for every
  // registered module its poll (or pending output) frame, each followed by three
  // dummy polls to address 0x00 — the turnaround padding seen verbatim in the
  // original log ("EF 10 0F 0F FF 00 0F 0F FF 00 0F 0F FF 00 0F 0F").
  buildBurst() {
    const parts = [];
    const consumed = [];
    for (const M of this.addrs) {
      const { frame, isOutput } = this.frameFor(M);
      parts.push(frame, BURST_PAD, BURST_PAD, BURST_PAD);
      if (isOutput) consumed.push(M & 0xff);
    }
    return { buffer: Buffer.concat(parts), consumed };
  }

  async _burst() {
    if (!this.addrs.length) return;
    const { buffer, consumed } = this.buildBurst();
    try {
      await this.writeFn(buffer);
      for (const M of consumed) this._consumePulse(M);
    } catch (e) { /* port closed mid-cycle; the caller stops us */ }
  }

  // Queue one output column. Several columns of the same module are merged and
  // leave as ONE segment in the next burst.
  // polls = 1: the original sends a changed column EXACTLY ONCE per change and
  // then clears its change flag. Repeating it (polls = 2) both re-triggered
  // ramp commands and kept a module's pending map alive long enough for an
  // already-sent column to ride along with the NEXT action — e.g. a stale
  // brightness level 11.3 re-sent together with the dimmer stop command, which
  // made the light flash brighter on release.
  queueOutput(M, sub, val, polls = 1, safetyMs = 10000) {
    M = M & 0xff;
    if (!this._pulseLeft) this._pulseLeft = new Map();
    if (!this._pulseTimers) this._pulseTimers = new Map();
    let cols = this.pending.get(M);
    if (!cols) { cols = new Map(); this.pending.set(M, cols); }
    cols.set(sub & 0x0f, val & 0xff);
    this._pulseLeft.set(M, Math.max(this._pulseLeft.get(M) || 0, Math.max(1, polls)));
    const prev = this._pulseTimers.get(M);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.pending.delete(M);
      this._pulseLeft.delete(M);
      this._pulseTimers.delete(M);
    }, safetyMs);
    this._pulseTimers.set(M, t);
  }

  // Frame to send for module M this cycle: manual override > pending output
  // columns > plain scan poll.
  frameFor(M) {
    M = M & 0xff;
    const ov = this.overrides.get(M);
    if (ov) return { frame: ov, isOutput: true };
    const cols = this.pending.get(M);
    if (cols && cols.size) {
      const columns = [...cols].map(([sub, val]) => ({ sub, val }));
      return { frame: buildOutputMulti(M, columns), isOutput: true };
    }
    return { frame: buildPoll(M), isOutput: false };
  }

  setOverride(M, frame) { if (frame) this.overrides.set(M & 0xff, frame); else this.overrides.delete(M & 0xff); }

  // Faithful output: the original master sends the [ctrl,val] pair once (when a
  // change flag is set), then reverts that module to scan-poll. We briefly
  // override the module's poll with the output frame, then clear it — the module
  // latches the relay level, so scan-poll afterwards keeps it. `ms` spans a few
  // poll cycles for reliability over USB.
  // NOTE: this must be poll-COUNT based, not time based. The poller walks the
  // module list round-robin, so a module's turn only comes every
  // addrs.length * intervalMs (e.g. 19 * 50ms = 950ms). A short wall-clock
  // window would expire before the module is ever polled and the frame would
  // never reach the wire. We therefore keep the override until the module has
  // actually been polled `polls` times, with a generous wall-clock safety net
  // in case the module drops out of the poll list entirely.
  pulseOutput(M, frame, polls = 1, safetyMs = 10000) {
    M = M & 0xff;
    if (!this._pulseLeft) this._pulseLeft = new Map();
    if (!this._pulseTimers) this._pulseTimers = new Map();
    this.setOverride(M, frame);
    this._pulseLeft.set(M, Math.max(1, polls));
    const prev = this._pulseTimers.get(M);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      if (this.overrides.get(M) === frame) this.setOverride(M, null);
      this._pulseLeft.delete(M);
      this._pulseTimers.delete(M);
    }, safetyMs);
    this._pulseTimers.set(M, t);
  }

  // Called by _tick after an override frame was actually written for M.
  _consumePulse(M) {
    if (!this._pulseLeft) return;
    const left = this._pulseLeft.get(M);
    if (left === undefined) return;              // manual override: keep forever
    if (left > 1) { this._pulseLeft.set(M, left - 1); return; }
    this._pulseLeft.delete(M);
    this.setOverride(M, null);
    this.pending.delete(M);
    const t = this._pulseTimers?.get(M);
    if (t) { clearTimeout(t); this._pulseTimers.delete(M); }
  }

  async _tick() {
    if (!this.addrs.length) return;
    const M = this.addrs[this.idx % this.addrs.length];
    this.idx++;
    const { frame, isOutput } = this.frameFor(M);
    try {
      await this.writeFn(frame);
      if (isOutput) this._consumePulse(M & 0xff);
      if (this.onPoll) this.onPoll(M, frame);
    } catch (e) { /* port closed mid-poll; the caller stops us */ }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  status() {
    return { running: this.running, mode: this.mode, intervalMs: this.intervalMs, addrs: this.addrs, count: this.addrs.length };
  }
}

export function defaultPollRange(start = 0x00, end = 0xff) {
  const a = [];
  for (let m = start; m <= end; m++) a.push(m);
  return a;
}
