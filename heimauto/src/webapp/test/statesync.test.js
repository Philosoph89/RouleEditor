// Module records hold ONLY what the rules wrote; reported input bits are kept
// separate and feed the relative-addressing context (00.x.y).
//
// Proven by the original event log (re/captures/Bedienung_2026-08-19):
//   (1A.0) <- 01   HWR relay bit only — NOT 0x43 with the module's input bits
//   (11.0) <- 20   dimmer memory bit only — NOT 0x36
// Merging reported bits into the record broke the shutters and the light.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RuleBase } from '../src/hrb.js';
import { Interpreter } from '../src/interpreter.js';

const rb = () => RuleBase.fromBuffer(readFileSync(new URL('../../RouleBase.hrb', import.meta.url)));

test('reported values never leak into the module record', () => {
  const it = new Interpreter(rb());
  it.state.register(0x1a);
  it.noteReported(0x1a, 0, 0x42);                 // module reports input bits
  assert.equal(it.state.getSubByte(0x1a, 0), 0x00, 'record stays rule-owned');
  assert.equal(it.getReported(0x1a, 0), 0x42, 'report is remembered separately');
});

test('mirrorContext exposes reported values as 00.x.y', () => {
  const it = new Interpreter(rb());
  it.noteReported(0x12, 0, 0x80);
  it.mirrorContext(0x12);
  assert.equal(it.state.getSubByte(0x00, 0), 0x80, 'context sees the input byte');
});

test('HWR light sends exactly the relay bit, like the original', () => {
  const it = new Interpreter(rb());
  for (const a of [0x00, 0x1a]) it.state.register(a);
  const KEY = (0x1a << 7) | 6;
  const sent = [];
  for (let n = 0; n < 4; n++) {
    it.noteReported(0x1a, 0, 0x42);               // button pressed + input bits
    it.mirrorContext(0x1a);
    it.processEventKey(KEY);
    sent.push(it.state.getSubByte(0x1a, 0));
  }
  assert.deepEqual(sent, [0x01, 0x00, 0x01, 0x00],
    'the original log shows (1A.0) <- 01 / 00 / 01 — no input bits');
});

test('shutter sends the same bytes as the original log', () => {
  // Original log: bit-0 button -> "(12.0) <- 03 + (12.7) <- 01" (up),
  //               bit-1 button -> "(12.0) <- 02 + (12.7) <- 01" (down),
  //               release       -> "(12.0) <- 00" (stop).
  const it = new Interpreter(rb());
  for (const a of [0x00, 0x12]) it.state.register(a);
  it.noteReported(0x12, 0, 0x01);                 // "up" button (bit 0) pressed
  it.mirrorContext(0x12);
  it.processEventKey((0x12 << 7) | 0);
  assert.equal(it.state.getSubByte(0x12, 0), 0x03, 'up = bits 0+1');
  assert.equal(it.state.getSubByte(0x12, 7), 0x01, 'marker bit set');

  it.noteReported(0x12, 1, 0x02);                 // "down" button (sub1 bit1)
  const it2 = new Interpreter(rb());
  for (const a of [0x00, 0x12]) it2.state.register(a);
  it2.noteReported(0x12, 0, 0x02);                // "down" button (bit 1)
  it2.mirrorContext(0x12);
  it2.processEventKey((0x12 << 7) | 1);
  assert.equal(it2.state.getSubByte(0x12, 0), 0x02, 'down = bit 1 only');
});

// Regression: die Modul-Map bildet unbekannte Adressen originalgetreu auf Slot 0
// ab. Schreibt eine Regel in ein noch nicht registriertes Modul, teilen sich
// mehrere Module denselben Speicher — beim Lüftungs-Tastendruck meldeten alle
// acht LED-Module denselben Wert. setModules registriert deshalb vorab.
test('setModules registriert alle bekannten Module (kein Slot-0-Aliasing)', async () => {
  const { readFileSync } = await import('node:fs');
  const { RuleBase } = await import('../src/hrb.js');
  const { Interpreter } = await import('../src/interpreter.js');
  const { LiveController } = await import('../src/livecontrol.js');
  const rb = RuleBase.fromBuffer(readFileSync(new URL('../../RouleBase.hrb', import.meta.url)));
  const it = new Interpreter(rb);
  const live = new LiveController(it);
  const addrs = [0x10, 0x11, 0x13, 0x15, 0x18, 0x19, 0x1b, 0x1c, 0x31];
  live.setModules(addrs);
  const slots = addrs.map((a) => it.state.slot(a));
  assert.equal(new Set(slots).size, addrs.length, 'jedes Modul braucht seinen eigenen Slot');
  // Slot 0 ist der Auffangplatz für unbekannte Adressen und muss dem
  // Kontext-Modul 0x00 gehören, nicht einem echten Modul.
  assert.equal(it.state.slot(0x00), 0);
  assert.equal(slots.includes(0), false, 'kein echtes Modul auf dem Auffang-Slot');

  // Getrennte Speicher: ein Schreibvorgang darf kein anderes Modul verändern
  it.state.setSubByte(0x10, 1, 0x04);
  it.state.setSubByte(0x31, 1, 0xf0);
  assert.equal(it.state.getSubByte(0x10, 1), 0x04);
  assert.equal(it.state.getSubByte(0x31, 1), 0xf0);
});
