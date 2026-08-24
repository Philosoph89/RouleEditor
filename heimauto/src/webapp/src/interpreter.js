// Faithful port of the RouleEditor rule interpreter.
//
// Transcribed from TSimulationForm.RBExecCmd (0x004692C0) and the executor
// TSimulationForm.ExecMsgList (0x0046B410), read at the assembly level
// (re/ghidra/asm_rbexec.txt). Data tables read from the binary:
//   bitmask  0x474E4C = {1,2,4,8,16,32,64,128}          (bit position -> mask)
//   chgmask  0x474E5C = {1,2,...,32768}                 (sub-address -> mask)
//   comparators FUN_0046AFC0 / FUN_0046B050 (identical):
//     op 0..5 = != == > =< < >=
//
// State model (module record = 80 bytes at 0x483000 + slot*80):
//   sub-address `s` (0..15) is a single byte at record + subOffset(s):
//       subOffset(s) = s < 8 ? 0x10 + s : 0x18 + s
//   bit operations address individual bits of that byte (bitmask table);
//   byte operations compare/assign the whole byte.
//   record + 0x28 is a 16-bit change-flag word (one bit per sub, chgmask).
//   module address byte -> slot via the map at 0x483F00 (registered on demand).
//
// Rule word fields: see src/ruleword.js. Execution returns a boolean per word;
// a rule "run" (sequence of words) stops as soon as a word returns false
// (condition chain: cond1 && cond2 && ... && actions).

import { extractFields } from './ruleword.js';
import { TimerTable } from './homebus.js';

const BITMASK = [1, 2, 4, 8, 16, 32, 64, 128];
const CHGMASK = Array.from({ length: 16 }, (_, i) => 1 << i);
const RECORD = 80; // 0x50
const N_SLOTS = 48;

// Byte comparator (FUN_0046B050 / FUN_0046AFC0): a = param2, b = param1.
// op: 0:a!=b 1:a==b 2:a>b 3:a<=b 4:a<b 5:a>=b  (else false)
function compare(op, a, b) {
  switch (op) {
    case 0: return a !== b;
    case 1: return a === b;
    case 2: return a > b;
    case 3: return a <= b;
    case 4: return a < b;
    case 5: return a >= b;
    default: return false;
  }
}

// Byte assignment operators (index from bits 28..30 of an odd-G word):
//   0 :=   1 ~=   2 &=   3 |=   4 ^=   5 +=   6 -=
function applyAssign(idx, cur, operand) {
  switch (idx) {
    case 0: return operand & 0xff;
    case 1: return (~operand) & 0xff;
    case 2: return (cur & operand) & 0xff;
    case 3: return (cur | operand) & 0xff;
    case 4: return (cur ^ operand) & 0xff;
    case 5: return (cur + operand) & 0xff;
    case 6: return (cur - operand) & 0xff;
    default: return null;
  }
}

function subOffset(sub) {
  return sub < 8 ? 0x10 + sub : 0x18 + sub;
}

export class HomeBusState {
  constructor() {
    this.S = new Uint8Array(N_SLOTS * RECORD);
    // module-address byte -> slot. The original's map (0x483F00) lives in
    // zero-initialised BSS, so any address not yet registered aliases slot 0.
    this.map = new Uint8Array(256);
    this.registered = new Set();
    this.nextSlot = 0;
    // Timers are id-addressed lists of at most 31 entries (verified: the
    // interpreter looks them up via FUN_00460300 with an id, not an index).
    this.stTable = new TimerTable(); // ShortTimer (0x4750E0)
    this.ltTable = new TimerTable(); // LongTimer  (0x475114)
    this.dt = { month: 1, day: 1, weekday: 0, hour: 0, minute: 0, second: 0 };
    this.changes = []; // emitted (module,sub) change events since last drain
  }

  // Register a module address, assigning the next free slot (like the original
  // building its module list as modules announce themselves). Up to 48 modules;
  // beyond that, extra modules alias the last slot (matches the clamp).
  register(addr) {
    addr &= 0xff;
    if (!this.registered.has(addr)) {
      this.map[addr] = Math.min(this.nextSlot++, N_SLOTS - 1);
      this.registered.add(addr);
    }
    return this.map[addr];
  }

  // Return the slot for an address. Unregistered addresses alias slot 0, exactly
  // like the original's zero-initialised map (no auto-registration, no crash).
  slot(addr) {
    return this.map[addr & 0xff];
  }

  base(addr) {
    return this.slot(addr) * RECORD;
  }

  getSubByte(addr, sub) {
    return this.S[this.base(addr) + subOffset(sub & 0xf)];
  }
  setSubByte(addr, sub, val) {
    this.S[this.base(addr) + subOffset(sub & 0xf)] = val & 0xff;
  }
  getBit(addr, sub, bit) {
    return (this.S[this.base(addr) + subOffset(sub & 0xf)] & BITMASK[bit & 7]) ? 1 : 0;
  }
  setBit(addr, sub, bit, v) {
    const o = this.base(addr) + subOffset(sub & 0xf);
    if (v) this.S[o] |= BITMASK[bit & 7];
    else this.S[o] &= (~BITMASK[bit & 7]) & 0xff;
  }
  // AddChgMsg (0x46AC70): mark sub changed in the record's +0x28 change word,
  // and record the event for output / re-evaluation.
  addChg(addr, sub) {
    const o = this.base(addr) + 0x28;
    const w = this.S[o] | (this.S[o + 1] << 8);
    const nw = w | CHGMASK[sub & 0xf];
    this.S[o] = nw & 0xff;
    this.S[o + 1] = (nw >> 8) & 0xff;
    this.changes.push({ module: addr & 0xff, sub: sub & 0xf });
  }
  drainChanges() {
    const c = this.changes;
    this.changes = [];
    return c;
  }

  snapshot() {
    const modules = [];
    for (const a of [...this.registered].sort((x, y) => x - y)) {
      const subs = [];
      for (let s = 0; s < 16; s++) subs.push({ sub: s, value: this.getSubByte(a, s) });
      modules.push({ module: a, slot: this.map[a], subs });
    }
    return { modules, st: this.stTable.list(), lt: this.ltTable.list(), dt: { ...this.dt } };
  }
}

export class Interpreter {
  constructor(rulebase) {
    this.rb = rulebase;
    this.state = new HomeBusState();
    this.log = [];
    // (module<<4)|sub -> last value the module REPORTED (never merged into the
    // module records; see noteReported)
    this.reported = new Map();
  }

  // Execute one rule word in the context of module base address `mb`.
  // Returns true/false (the [-0x31] result flag). Assignments return true.
  execWord(mb, word) {
    const f = extractFields(word, mb);
    const S = this.state;
    // destination module address = map index D = (W>>20)&0xff
    const dstAddr = f.dstModAddrByte;
    const srcAddr = f.srcModAddrByte;
    const cmpOp = f.dstBit; // (W>>28)&7, doubles as comparator operator for value ops

    if (f.bit31 === 0) {
      // two-operand bit op: selector = bit15*2 + bit11. For bit ops the source
      // module address is only 7 bits — bit 7 of srcModAddrByte IS bit11 (the
      // selector flag), so it must be masked off (matches compiler.decode()).
      const sel = f.bit15 * 2 + f.bit11;
      const srcBitAddr = srcAddr & 0x7f;
      const d = S.getBit(dstAddr, f.dstSub, f.dstBit);
      const s = S.getBit(srcBitAddr, f.srcSub, f.srcBit);
      switch (sel) {
        case 0: return d !== s;                 // !=
        case 1: return d === s;                 // ==
        case 2: S.setBit(dstAddr, f.dstSub, f.dstBit, s); S.addChg(dstAddr, f.dstSub); return true; // :=
        case 3: S.setBit(dstAddr, f.dstSub, f.dstBit, s ? 0 : 1); S.addChg(dstAddr, f.dstSub); return true; // ~=
      }
    }

    switch (f.G) {
      case 0: return S.getBit(dstAddr, f.dstSub, f.dstBit) === 0;      // Ma.Sa.Bit == 0
      case 1: return S.getBit(dstAddr, f.dstSub, f.dstBit) !== 0;      // Ma.Sa.Bit == 1
      case 2: S.setBit(dstAddr, f.dstSub, f.dstBit, 0); S.addChg(dstAddr, f.dstSub); return true; // := 0
      case 3: S.setBit(dstAddr, f.dstSub, f.dstBit, 1); S.addChg(dstAddr, f.dstSub); return true; // := 1
      // G -> family, derived from the real rule base via the verified codec:
      //   4 BYTE_BYTE cmp    5 BYTE_BYTE assign
      //   6 BYTE_CONST cmp   7 BYTE_CONST assign
      //   8 ST/LST cmp       9 ST/LST load
      //  10 LT/LLT cmp      11 LT/LLT load      12 DT cmp
      // For compares (even G) bits 28..30 hold the comparator index 0..5; for
      // assignments (odd G) they hold the assignment index 0..6
      // (:= ~= &= |= ^= += -=).
      case 4: return compare(cmpOp, S.getSubByte(dstAddr, f.dstSub), S.getSubByte(srcAddr, f.srcSub));
      case 6: return compare(cmpOp, S.getSubByte(dstAddr, f.dstSub), f.const8);
      case 5: case 7: {
        const cur = S.getSubByte(dstAddr, f.dstSub);
        const operand = (f.G === 7) ? f.const8 : S.getSubByte(srcAddr, f.srcSub);
        const next = applyAssign(f.dstBit, cur, operand);
        if (next === null) return false;
        S.setSubByte(dstAddr, f.dstSub, next);
        S.addChg(dstAddr, f.dstSub);
        return true;
      }
      // Timer id = (eventKey & 0x7FF0) | timerNr  -> f.dstModuleAddr, which is
      // ALSO the event key fired when the timer expires. Verified: the shutter
      // rule "LST9 := 30.0" under event key 0xC87 yields id 0xC89, and 0xC89 is
      // exactly the groupId of the stop rule "19.0.1 := 0; 19.0.0 := 0".
      // Units: ShortTimer 0.5 s per count, LongTimer 1 minute per count.
      case 8: return compare(cmpOp, S.stTable.get(f.dstModuleAddr), f.timerValue);
      case 10: return compare(cmpOp, S.ltTable.get(f.dstModuleAddr), f.timerValue);
      case 9: S.stTable.set(f.dstModuleAddr, f.timerValue); return true;
      case 11: S.ltTable.set(f.dstModuleAddr, f.timerValue); return true;
      case 12: return this.compareDateTime(cmpOp, f);                 // DateTime compare
      default: return false;
    }
  }

  // DateTime compare: the word packs month/day/weekday/hour/min fields; '*'
  // (wildcard) matches anything. Best-effort per the DFM field semantics.
  compareDateTime(op, f) {
    const dt = this.state.dt;
    const hour = f.dtHour;   // (W>>6)&0x1f, <24 else wildcard
    const min = f.dtMinSec;  // (W)&0x3f,  <60 else wildcard
    let ok = true;
    if (hour < 24) ok = ok && compare(op, dt.hour, hour);
    if (min < 60) ok = ok && compare(op, dt.minute, min);
    return ok;
  }

  // Execute one rule run (sequence of words); stop at the first false word.
  // `ek` is the EVENT KEY of this run, not just the module address: timer ids
  // are (eventKey & 0x7FF0) | timerNr, so the full key must reach extractFields.
  // Module addressing itself comes from the word (dstModAddrByte), with the
  // relative form 00.x.y served by the CTX mirror module 0x00.
  execRun(ek, words) {
    let fired = 0;
    for (const w of words) {
      const r = this.execWord(ek, w);
      fired++;
      if (!r) break;
    }
    return fired;
  }

  // Find the rule runs whose index key matches module address `addr` and run
  // them (the ExecMsgList inner loop). The index groupId encodes the module.
  processModule(addr) {
    const runs = this.rb.commandRuns();
    let executed = 0;
    for (const run of runs) {
      if ((run.entry.groupId & 0xffff) !== (addr & 0xffff)) continue;
      this.execRun(run.entry.groupId, run.rules);
      executed++;
    }
    return executed;
  }

  // Execute the rule run(s) for one event key. The event key encodes the
  // triggering module and input bit: key = (module << 7) | (sub*8 + bit).
  // Verified: the switch rule 1A.0.0~=1A.0.0 lives in run groupId 0xD06 =
  // (0x1A<<7)|(0*8+6), i.e. module 0x1A, sub 0, bit 6 (the push-button).
  processEventKey(key) {
    const runs = this.rb.commandRuns();
    const base = (key >> 7) & 0xff;
    const fired = [];
    for (const run of runs) {
      if (run.entry.groupId !== key) continue;
      this.state.drainChanges();
      this.execRun(run.entry.groupId, run.rules);
      const changes = this.state.drainChanges();
      fired.push({ eventKey: key, module: base, rest: key & 0x7f, changes });
    }
    return fired;
  }

  // Compose an event key from a module input bit change.
  static eventKey(module, sub, bit) {
    return (((module & 0xff) << 7) | (((sub & 0x0f) * 8 + (bit & 7)) & 0x7f)) & 0xffff;
  }

  // Inject a module byte (an input change) and evaluate rules for it, following
  // change propagation until the queue drains (bounded).
  inject(addr, sub, value) {
    this.state.register(addr);
    this.state.setSubByte(addr, sub, value);
    this.state.drainChanges();
    const queue = [addr & 0xff];
    const seen = new Set();
    let steps = 0;
    while (queue.length && steps < 10000) {
      const a = queue.shift();
      this.processModule(a);
      for (const c of this.state.drainChanges()) {
        const key = c.module;
        if (!seen.has(key)) { seen.add(key); queue.push(key); }
      }
      steps++;
    }
    return { steps };
  }

  // ShortTimer / LongTimer maintenance, driven by the time base (SystemTimer:
  // ShortTimer every 2nd tick, LongTimer every 240 ticks).
  tickShortTimers() {
    const fired = [];
    for (const id of this.state.stTable.tick()) fired.push(...this.onTimerExpired(id, 'ST'));
    return fired;
  }
  tickLongTimers() {
    const fired = [];
    for (const id of this.state.ltTable.tick()) fired.push(...this.onTimerExpired(id, 'LT'));
    return fired;
  }
  // Values the modules REPORT, kept separate from the module records.
  //
  // Verified against the original event log: the master writes back ONLY what
  // its rules put into a record — "(1A.0) <- 01" for the HWR relay, not 0x43,
  // and "(11.0) <- 20" for the dimmer memory bit, not 0x36. Reported input bits
  // therefore must NOT be merged into the record; they are only used for the
  // relative-addressing context (00.x.y) and for change detection.
  noteReported(module, sub, val) {
    this.reported.set((((module & 0xff) << 4) | (sub & 0x0f)), val & 0xff);
  }
  getReported(module, sub) {
    return this.reported.get((((module & 0xff) << 4) | (sub & 0x0f)));
  }

  // Copy every sub-byte of `module` into the relative-context module 0x00, so
  // rules written as 00.x.y see the triggering module's real state.
  mirrorContext(module) {
    const S = this.state;
    S.register(0x00); S.register(module & 0xff);
    for (let s = 0; s < 16; s++) {
      const v = this.getReported(module, s);
      if (v !== undefined) S.setSubByte(0x00, s, v);
    }
  }

  // An expiring timer fires the event key that EQUALS its id (verified: timer id
  // 0xC89 -> run groupId 0xC89, the HWR shutter stop rule).
  //
  // But ONLY timer numbers 8..15 are expiry timers. The id's low nibble is the
  // timer number, and as an event key that nibble becomes sub*8+bit — numbers
  // 8..15 land on sub 1, exactly the range the rule base uses for its
  // "Ablaufevents" (36 such runs), while 0..7 land on sub 0 where the PHYSICAL
  // BUTTONS live (23 collisions in this rule base). Low numbers are pure
  // stopwatches, only ever read via comparisons like "LST0 > 0.0".
  // Firing them executed a random button handler: the kitchen light loads LST0,
  // whose id 0x900 is the shutter-UP key of module 0x12 — so switching the
  // kitchen light off stopped the kitchen-east shutter.
  onTimerExpired(id, kind) {
    this.log.push({ t: Date.now(), type: 'timer-expired', kind, id });
    if ((id & 0x0f) < 8) return [];              // stopwatch, no expiry event
    this.mirrorContext((id >> 7) & 0xff);
    return this.processEventKey(id);
  }

  // One full evaluation pass over the whole rule base (all registered modules).
  runAll() {
    let fired = 0;
    const runs = this.rb.commandRuns();
    for (const run of runs) {
      fired += this.execRun(run.entry.groupId, run.rules);
    }
    return { fired, runs: runs.length };
  }
}
