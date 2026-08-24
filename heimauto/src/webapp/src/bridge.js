// HomeBus <-> Home Assistant bridge.
//
// This is the layer that makes the plant's I/O directly orchestrable from Home
// Assistant instead of from the .hrb rule base:
//
//   input  poll reply -> LiveController -> onInput -> entity state -> MQTT
//   output MQTT command -> entity command -> output byte -> Poller.queueOutput
//
// OUTPUT SHADOW. A HomeBus output frame always carries a WHOLE sub-byte, so
// switching one relay of an 8-relay module must not clear the other seven. The
// bridge therefore keeps a shadow of every output byte it has ever written
// (persisted, so a restart does not forget the plant's state) and always sends
// the full byte.
//
// COVERS. The modules have no end-position feedback and no built-in run time:
// the original PC master started the motor and stopped it again when a
// ShortTimer expired (e.g. LST9 := 30.0). In bridge mode the rule base is not
// running, so the bridge owns that timing itself — it starts the motor, tracks
// an estimated position from the travel time recovered from the rule base, and
// sends the stop frame when the target position is reached.

import { DIM, DIM_LEVEL_MAX } from './entities.js';

const key = (M, sub) => `${(M & 0xff).toString(16).padStart(2, '0')}.${sub & 0x0f}`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Bridge {
  // queueOutput(M, sub, val) — normally Poller.queueOutput.bind(poller)
  constructor({ queueOutput, tickMs = 250 } = {}) {
    this.queueOutput = queueOutput || (() => {});
    this.entities = new Map();          // id -> entity definition
    this.byInput = new Map();           // "M.sub" -> input entities on that byte
    this.outputs = new Map();           // "M.sub" -> byte we hold
    this.inputs = new Map();            // "M.sub" -> last reported byte
    this.covers = new Map();            // id -> { position, target, dir, moving, startedAt }
    this.dimmers = new Map();           // id -> { on, level }
    this.onState = null;                // (entity, state) -> publish
    this.onLog = null;
    this.tickMs = tickMs;
    this.timer = null;
  }

  setEntities(list) {
    this.entities = new Map(list.filter((e) => e.enabled !== false).map((e) => [e.id, e]));
    // index the inputs by (module, sub) — noteInput runs for every poll reply
    this.byInput = new Map();
    for (const e of this.entities.values()) {
      if (e.kind !== 'button') continue;
      const k = key(e.module, e.sub);
      if (!this.byInput.has(k)) this.byInput.set(k, []);
      this.byInput.get(k).push(e);
    }
    for (const e of this.entities.values()) {
      if (e.kind === 'cover' && !this.covers.has(e.id)) {
        this.covers.set(e.id, { position: 50, target: null, dir: 0, moving: false, unknown: true });
      }
      if (e.kind === 'dimmer' && !this.dimmers.has(e.id)) {
        this.dimmers.set(e.id, { on: false, level: 0 });
      }
    }
  }

  // --- persistence ---------------------------------------------------------
  snapshot() {
    return {
      outputs: Object.fromEntries(this.outputs),
      covers: Object.fromEntries([...this.covers].map(([id, c]) => [id, { position: c.position, unknown: c.unknown }])),
      dimmers: Object.fromEntries(this.dimmers),
    };
  }
  restore(snap) {
    if (!snap) return;
    for (const [k, v] of Object.entries(snap.outputs || {})) this.outputs.set(k, v & 0xff);
    for (const [id, v] of Object.entries(snap.covers || {})) {
      this.covers.set(id, { position: clamp(Number(v.position) || 0, 0, 100), target: null,
                            dir: 0, moving: false, unknown: v.unknown !== false });
    }
    for (const [id, v] of Object.entries(snap.dimmers || {})) {
      this.dimmers.set(id, { on: Boolean(v.on), level: clamp(Number(v.level) || 0, 0, DIM_LEVEL_MAX) });
    }
  }

  start() { this.stop(); this.timer = setInterval(() => this._tick(), this.tickMs); }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  get running() { return Boolean(this.timer); }

  // --- raw output ----------------------------------------------------------
  getByte(M, sub) { return this.outputs.get(key(M, sub)) ?? 0; }

  setByte(M, sub, val) {
    this.outputs.set(key(M, sub), val & 0xff);
    this.queueOutput(M & 0xff, sub & 0x0f, val & 0xff);
    return val & 0xff;
  }

  // Set/clear one bit of an output byte, preserving every other bit.
  setBit(M, sub, bit, on) {
    const cur = this.getByte(M, sub);
    const next = on ? (cur | (1 << bit)) : (cur & ~(1 << bit) & 0xff);
    return this.setByte(M, sub, next);
  }

  getBit(M, sub, bit) { return (this.getByte(M, sub) >> bit) & 1; }

  // --- entity commands -----------------------------------------------------
  // Returns the new state object, or throws for an unknown entity/command.
  command(id, cmd) {
    const e = this.entities.get(id);
    if (!e) throw new Error(`unknown entity ${id}`);
    switch (e.kind) {
      case 'switch':
      case 'light':   return this._cmdRelay(e, cmd);
      case 'dimmer':  return this._cmdDimmer(e, cmd);
      case 'cover':   return this._cmdCover(e, cmd);
      case 'button':  throw new Error(`${id} is an input and cannot be commanded`);
      default:        throw new Error(`entity kind ${e.kind} has no command`);
    }
  }

  _cmdRelay(e, cmd) {
    const on = typeof cmd === 'object' ? Boolean(cmd.on) : /^(on|1|true)$/i.test(String(cmd));
    if (typeof cmd === 'object' && cmd.toggle) return this._publish(e, this._relayState(e, !this.getBit(e.module, e.sub, e.bit)));
    if (typeof cmd === 'string' && /^toggle$/i.test(cmd)) {
      return this._publish(e, this._relayState(e, !this.getBit(e.module, e.sub, e.bit)));
    }
    return this._publish(e, this._relayState(e, on));
  }

  _relayState(e, on) {
    this.setBit(e.module, e.sub, e.bit, on ? 1 : 0);
    return { state: on ? 'ON' : 'OFF' };
  }

  // Dimmer: level byte (M.3) + command byte (M.4 = $30 "apply level").
  // brightness is the Home Assistant scale 0..255, the module's is 0..0x40.
  _cmdDimmer(e, cmd) {
    const st = this.dimmers.get(e.id) || { on: false, level: 0 };
    const obj = typeof cmd === 'object' ? cmd : { state: String(cmd) };
    const max = e.levelMax || DIM_LEVEL_MAX;
    let on = st.on;
    if (obj.state !== undefined) on = /^(on|1|true)$/i.test(String(obj.state));
    let level = st.level;
    if (obj.brightness !== undefined) {
      level = clamp(Math.round((Number(obj.brightness) / 255) * max), 0, max);
      on = level > 0;
    }
    if (on && level === 0) level = max;               // "on" without brightness = full
    const send = on ? level : 0;
    this.setByte(e.module, e.levelSub ?? 3, send);
    this.setByte(e.module, e.cmdSub ?? 4, DIM.APPLY);
    const next = { on, level: on ? level : st.level || max };
    this.dimmers.set(e.id, next);
    return this._publish(e, { state: on ? 'ON' : 'OFF',
                              brightness: Math.round((next.level / max) * 255) });
  }

  // Ramp while a physical button is held is a rule-base feature; over MQTT we
  // expose absolute levels, plus explicit ramp commands for completeness.
  dimRamp(id, dir) {
    const e = this.entities.get(id);
    if (!e || e.kind !== 'dimmer') throw new Error(`${id} is not a dimmer`);
    const cmd = dir === 'up' ? DIM.RAMP_UP : dir === 'down' ? DIM.RAMP_DOWN : DIM.STOP;
    this.setByte(e.module, e.cmdSub ?? 4, cmd);
    return { ramp: dir };
  }

  _cmdCover(e, cmd) {
    const st = this.covers.get(e.id);
    const obj = typeof cmd === 'object' ? cmd : { action: String(cmd) };
    const action = String(obj.action || obj.state || '').toUpperCase();
    if (obj.position !== undefined) return this._coverTo(e, clamp(Number(obj.position), 0, 100));
    if (action === 'OPEN') return this._coverTo(e, 100);
    if (action === 'CLOSE') return this._coverTo(e, 0);
    if (action === 'STOP') return this._coverStop(e);
    throw new Error(`unknown cover command ${action || JSON.stringify(cmd)}`);
  }

  // dir bit (even) 1 = up/open, 0 = down/close; run bit (odd) 1 = motor on.
  _coverTo(e, target) {
    const st = this.covers.get(e.id);
    if (!st.unknown && Math.abs(st.position - target) < 1) return this._coverStop(e);
    const up = target > st.position || st.unknown && target === 100;
    st.target = target;
    st.dir = up ? 1 : -1;
    st.moving = true;
    st.startedAt = Date.now();
    // one frame, both bits: direction first, then run — same byte, so one write
    let byte = this.getByte(e.module, e.sub);
    byte = up ? (byte | (1 << e.bitDir)) : (byte & ~(1 << e.bitDir) & 0xff);
    byte |= (1 << e.bitRun);
    this.setByte(e.module, e.sub, byte);
    return this._publish(e, this.coverState(e));
  }

  _coverStop(e) {
    const st = this.covers.get(e.id);
    st.moving = false;
    st.target = null;
    st.dir = 0;
    let byte = this.getByte(e.module, e.sub);
    byte &= ~(1 << e.bitRun) & 0xff;
    byte &= ~(1 << e.bitDir) & 0xff;      // the original clears both on stop
    this.setByte(e.module, e.sub, byte);
    return this._publish(e, this.coverState(e));
  }

  coverState(e) {
    const st = this.covers.get(e.id);
    const pos = Math.round(st.position);
    const state = st.moving ? (st.dir > 0 ? 'opening' : 'closing')
                : st.unknown ? 'open'
                : pos <= 0 ? 'closed' : 'open';
    return { state, position: pos };
  }

  // --- travel simulation ---------------------------------------------------
  _tick() {
    const now = Date.now();
    for (const e of this.entities.values()) {
      if (e.kind !== 'cover') continue;
      const st = this.covers.get(e.id);
      if (!st?.moving) continue;
      const travelMs = (Number(e.travelSec) || 30) * 1000;
      const step = ((now - (st.lastTick || st.startedAt)) / travelMs) * 100;
      st.lastTick = now;
      st.position = clamp(st.position + st.dir * step, 0, 100);
      st.unknown = false;
      const done = st.target === null
        || (st.dir > 0 && st.position >= st.target - 0.5)
        || (st.dir < 0 && st.position <= st.target + 0.5);
      if (done) {
        st.position = st.target === null ? st.position : st.target;
        st.lastTick = null;
        this._coverStop(e);
      } else {
        this._publish(e, this.coverState(e));
      }
    }
  }

  // --- inputs --------------------------------------------------------------
  // Called for every reported input byte (LiveController.onInput).
  noteInput(M, sub, prev, val) {
    const k = key(M, sub);
    this.inputs.set(k, val & 0xff);
    const changed = prev === undefined ? 0xff : (prev ^ val) & 0xff;
    for (const e of this.byInput?.get(k) || []) {
      if (!(changed & (1 << e.bit))) continue;
      this._publish(e, { state: (val >> e.bit) & 1 ? 'ON' : 'OFF' });
    }
  }

  // Current state of an entity (used for the initial MQTT publish and the UI).
  stateOf(e) {
    switch (e.kind) {
      case 'switch':
      case 'light':
        return { state: this.getBit(e.module, e.sub, e.bit) ? 'ON' : 'OFF' };
      case 'dimmer': {
        const st = this.dimmers.get(e.id) || { on: false, level: 0 };
        const max = e.levelMax || DIM_LEVEL_MAX;
        return { state: st.on ? 'ON' : 'OFF', brightness: Math.round(((st.level || max) / max) * 255) };
      }
      case 'cover':
        return this.coverState(e);
      case 'button': {
        const byte = this.inputs.get(key(e.module, e.sub));
        if (byte === undefined) return null;
        return { state: (byte >> e.bit) & 1 ? 'ON' : 'OFF' };
      }
      default: return null;
    }
  }

  publishAll() {
    for (const e of this.entities.values()) {
      const st = this.stateOf(e);
      if (st) this._publish(e, st);
    }
  }

  _publish(e, state) {
    if (this.onState) { try { this.onState(e, state); } catch { /* non-fatal */ } }
    return state;
  }
}
