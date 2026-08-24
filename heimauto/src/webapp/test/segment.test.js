// Byte-exact output segments, checked against BOTH original event logs.
//
// The 0x40 bit of every ctrl byte mirrors bit 0x40 of the byte immediately
// before it: the module address for the first pair, the PREVIOUS PAIR'S VALUE
// for each following pair (the same rule the RX deframer enforces,
// (buf[p-1] & 0x40) === (buf[p] & 0x40)).
//
// This is what broke the kitchen dimmer: the level byte 0x40 has bit 6 set, so
// the following ctrl must be E4 — we sent A4, the module rejected the set-level
// command and kept ramping ("light slowly gets brighter instead of full on").
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutput, buildOutputMulti } from '../src/homebus.js';

const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

test('kitchen dimmer segments match the original log byte for byte', () => {
  // 19.08.2026 21:02:54.948  EE 11 93 40 E4 30 07   (11.3)<-40 (11.4)<-30  = ON
  assert.equal(hex(buildOutputMulti(0x11, [{ sub: 3, val: 0x40 }, { sub: 4, val: 0x30 }])),
    'EE 11 93 40 E4 30 07', 'level 0x40 sets bit 6 -> next ctrl must be E4');
  // (11.3)<-00 (11.4)<-30  = OFF
  assert.equal(hex(buildOutputMulti(0x11, [{ sub: 3, val: 0x00 }, { sub: 4, val: 0x30 }])),
    'EE 11 93 00 A4 30 07');
  // 19.08.2026 21:02:54.821  EE 11 30 20 04 15 01   (11.0)<-20 (11.4)<-15  = ramp
  assert.equal(hex(buildOutputMulti(0x11, [{ sub: 0, val: 0x20 }, { sub: 4, val: 0x15 }])),
    'EE 11 30 20 04 15 01');
});

test('single-column frames stay exactly as verified before', () => {
  // live-verified HWR relay + the first log's "(10.F) <- 10"
  assert.equal(hex(buildOutput(0x1a, 0, 0x01)), 'E5 1A 00 01 01');
  assert.equal(hex(buildOutput(0x10, 0xf, 0x10)), 'EF 10 1F 10 0F');
});

test('bit 6 of the module address still feeds the first ctrl byte', () => {
  // M = 0x41 has bit 6 set, so the first ctrl carries it
  const seg = buildOutputMulti(0x41, [{ sub: 3, val: 0x00 }]);
  assert.equal(seg[2] & 0x40, 0x40, 'first ctrl mirrors the module address bit 6');
});

test('a value with bit 6 set propagates into the following ctrl', () => {
  const seg = buildOutputMulti(0x11, [{ sub: 1, val: 0x40 }, { sub: 2, val: 0x00 }]);
  assert.equal(seg[2] & 0x40, 0x00, 'first ctrl: from module address 0x11');
  assert.equal(seg[4] & 0x40, 0x40, 'second ctrl: from previous value 0x40');
});
