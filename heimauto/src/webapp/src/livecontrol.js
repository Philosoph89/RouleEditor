// Live master automaton (Methode 3): feed real poll responses into the
// interpreter, run the rules, surface the computed outputs, and drive them back
// onto the bus as real output frames (onOutput -> buildOutput, verified live
// switching the HWR relay on module 0x1A).
//
// Verified chain (module 0x1A light switch):
//   poll response [~M,M,ctrl,val] -> sub=ctrl&0x0F, val
//   a changed input bit b -> event key (M<<7)|(sub*8+b)   (e.g. 0xD06)
//   rule run 0xD06:  00.0.6==1  (button, relative addr 00 = event module)
//                    1A.0.0~=1A.0.0  (toggle relay)
// Relative address 00 in a rule means "the event module": we mirror the polled
// input byte into module 0x00 so the condition sees it, while the absolute
// address (1A) keeps the PC-held output state.

import { Interpreter } from './interpreter.js';

const CTX = 0x00; // relative "self / event module" context address

export class LiveController {
  constructor(interpreter) {
    this.it = interpreter;
    this.buf = [];
    this.modules = [];
    this.stable = new Map();   // M*16+sub -> last stable input value
    this.onAutomat = null;     // callback(event)
    this.onOutput = null;      // callback(module, sub, val) -> drive hardware relay
    // Bridge mode: report every input change to Home Assistant and let HA decide.
    this.onInput = null;       // callback(module, sub, prevVal, val)
    this.rules = true;         // false = do not run the .hrb rule base at all
    this.timer = null;
    this.windowMs = 200;
  }

  setModules(addrs) { this.modules = (addrs || []).slice(); }
  setInterpreter(it) { this.it = it; this.stable.clear(); }

  feed(bytes) {
    for (const b of bytes) this.buf.push(b);
    if (this.buf.length > 16000) this.buf = this.buf.slice(-8000);
  }

  get running() { return Boolean(this.timer); }
  start(windowMs = 200) { this.stop(); this.windowMs = windowMs; this.timer = setInterval(() => this._tick(), windowMs); }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  // Extract, per module, the most frequent (ctrl,val) pair in the window and
  // detect input changes (debounced against fragmentation).
  // Walk the whole RX window and process EVERY reported sub-byte.
  //
  // Reply layout: [~M, M, (ctrl,val)*, checksum]. ctrl&0x0F is the sub-address;
  // ctrl&0x0F == 0x0F means "nothing to report" (then the next byte is just the
  // checksum) and ctrl&0x10 means "another pair follows".
  //
  // The previous version took only the MOST FREQUENT (ctrl,val) pair per module
  // per window. Modules that idle at 0F 0F and report a change only once — e.g.
  // the kitchen button on module 0x12 — lost that single report to the idle
  // majority, so the press never produced an event at all.
  _tick() {
    const buf = this.buf;
    this.buf = [];
    if (buf.length < 4) return;
    const known = new Set(this.modules.map((m) => m & 0xff));
    let i = 0;
    while (i + 3 < buf.length) {
      if (buf[i + 1] !== ((~buf[i]) & 0xff)) { i++; continue; }   // sync rule
      const M = buf[i + 1] & 0xff;
      let p = i + 2;
      if ((buf[p] & 0x0f) === 0x0f) { i = p + 2; continue; }      // idle reply
      let guard = 0;
      for (;;) {
        const ctrl = buf[p], val = buf[p + 1];
        if (known.has(M)) this._report(M, ctrl & 0x0f, val & 0xff);
        p += 2;
        if (!(ctrl & 0x10) || ++guard > 15 || p + 1 >= buf.length) break;
      }
      i = p + 1;                                                  // trailing checksum
    }
  }

  _report(M, sub, val) {
    if (sub >= 0x0f) return;
    // Keep the module's OWN record in sync with what the hardware reports. The
    // original holds the reported sub-bytes in its module records (0x483000+),
    // so a rule like "11.0.5 ~= 11.0.5" toggles one bit of the REAL byte and
    // sending it back preserves every other bit. Mirroring only into the CTX
    // module left our record a fantasy (e.g. we sent 0xA0 while the dimmer
    // module actually reported 0x16, clobbering bits 1, 2 and 4).
    // setSubByte does NOT set a change flag, so syncing never causes an output.
    // Remember what the module reported. It feeds the relative-addressing
    // context (00.x.y) but must NEVER be merged into the module record: the
    // original writes back only rule-owned values ("(1A.0) <- 01", not 0x43).
    if (this.it) { this.it.state.register(M); this.it.noteReported(M, sub, val); }
    const key = (M << 4) | sub;
    const prev = this.stable.get(key);
    this.stable.set(key, val);
    if (prev === val) return;
    // Report first, unconditionally: in bridge mode Home Assistant is the only
    // consumer, and the very first report (prev === undefined) seeds the states.
    if (this.onInput) { try { this.onInput(M, sub, prev, val); } catch { /* non-fatal */ } }
    if (prev !== undefined && this.rules) this._process(M, sub, prev, val);
  }


  _process(M, sub, prev, val) {
    const S = this.it.state;
    S.register(CTX); S.register(M);
    // Relative addressing 00.x.y means "the event module": mirror ALL of its
    // sub-bytes into the context module, not just the one that changed — rules
    // read several subs (e.g. 00.0.4 together with 00.1.3).
    this.it.mirrorContext(M);
    const changed = (prev ^ val) & 0xff;
    for (let b = 0; b < 8; b++) {
      if (!(changed & (1 << b))) continue;
      const ek = Interpreter.eventKey(M, sub, b);
      const fired = this.it.processEventKey(ek);
      // Coalesce per (module, sub): a chain may touch several bits of the same
      // sub-byte (e.g. "19.0.0 := 0; 19.0.1 := 1"), which is ONE byte on the
      // wire. The original sets a change flag and sends the byte's final value
      // once per burst, so we send the final value once instead of one frame
      // per bit.
      const finals = new Map();
      for (const f of fired) {
        for (const c of f.changes) {
          finals.set(((c.module & 0xff) << 4) | (c.sub & 0x0f),
                     { module: c.module & 0xff, sub: c.sub & 0x0f });
        }
      }
      const outputs = [];
      for (const { module, sub } of finals.values()) {
        const value = S.getSubByte(module, sub) & 0xff;
        outputs.push({ module, sub, value });
        // Drive real bus modules (absolute address). CTX 0x00 is the relative
        // event-module mirror and is never a physical output.
        if (module !== CTX && this.onOutput && this.modules.includes(module)) {
          this.onOutput(module, sub, value);
        }
      }
      if (this.onAutomat) {
        this.onAutomat({
          t: 0, module: M, sub, bit: b,
          rising: Boolean(val & (1 << b)),
          inputHex: '0x' + val.toString(16).padStart(2, '0'),
          eventKey: ek, ran: fired.length, outputs,
        });
      }
    }
  }
}
