import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RuleBase, CHECKSUM_CONST } from '../src/hrb.js';
import { encodeRule, decodeRule } from '../src/opcodes.js';

const here = dirname(fileURLToPath(import.meta.url));
const HRB = join(here, '..', '..', 'RouleBase.hrb');

test('parses the shipped RouleBase.hrb', () => {
  const buf = readFileSync(HRB);
  const rb = RuleBase.fromBuffer(buf);
  assert.equal(rb.index.length, 578, 'index entries');
  assert.equal(rb.commands.length, 3704, 'rule words (declared)');
  assert.equal(rb.hasBalancer, true, 'balancer present');
  assert.equal(rb.storedChecksum, CHECKSUM_CONST, 'file XOR == 0x15');
  assert.equal(rb.checksumOk, true);
});

test('round-trips byte-exact', () => {
  const buf = readFileSync(HRB);
  const rb = RuleBase.fromBuffer(buf);
  const out = rb.toBuffer(false);
  assert.equal(out.length, buf.length, 'same length');
  assert.ok(out.equals(buf), 'identical bytes');
});

test('edit + rebuild keeps the checksum invariant', () => {
  const rb = RuleBase.fromBuffer(readFileSync(HRB));
  rb.commands.push(0x00000000); // append a NOP rule
  const words = rb.toWords(true);
  let acc = 0;
  for (const w of words) acc = (acc ^ w) >>> 0;
  assert.equal(acc, CHECKSUM_CONST, 'rebuilt XOR == 0x15');
});

test('rule field codec round-trips', () => {
  const f = { isTimerEvent: true, dstBit: 5, dstSub: 9, srcBit: 3, op5: 21, srcSub: 7, operand12: 0xabc };
  const w = encodeRule(f);
  const d = decodeRule(w);
  assert.equal(d.isTimerEvent, true);
  assert.equal(d.dstBit, 5);
  assert.equal(d.dstSub, 9);
  assert.equal(d.srcBit, 3);
  assert.equal(d.op5, 21);
  assert.equal(d.srcSub, 7);
  assert.equal(d.operand12, 0xabc);
});

test('command runs cover the index', () => {
  const rb = RuleBase.fromBuffer(readFileSync(HRB));
  const runs = rb.commandRuns();
  assert.equal(runs.length, 578);
  assert.equal(runs[0].entry.groupId, 8);
});

import { canonicalFields, packCanonical, classify } from '../src/ruleword.js';

test('canonical codec round-trips byte-exact on every rule', () => {
  const rb = RuleBase.fromBuffer(readFileSync(HRB));
  let mism = 0;
  for (const w of rb.commands) if (packCanonical(canonicalFields(w)) !== (w >>> 0)) mism++;
  assert.equal(mism, 0, 'all rule words repack exactly');
});

test('classifier assigns a valid opcode name to (nearly) every rule', () => {
  const rb = RuleBase.fromBuffer(readFileSync(HRB));
  let edge = 0;
  for (const w of rb.commands) {
    const c = classify(w);
    assert.ok(c.name && c.kind, 'has name+kind');
    if (String(c.operator || '').startsWith('?')) edge++;
  }
  assert.ok(edge <= 5, `at most a handful of edge operators (got ${edge})`);
});

import { Interpreter } from '../src/interpreter.js';

test('interpreter runs the real rulebase without error', () => {
  const rb = RuleBase.fromBuffer(readFileSync(HRB));
  const it = new Interpreter(rb);
  const r = it.runAll();
  assert.ok(r.runs === 578 && r.fired > 0, 'executes all runs');
});

test('interpreter executes a condition->action chain faithfully', () => {
  const cond = packCanonical({ bit31: 1, dstBit: 0, dstModAddrByte: 5, dstSub: 0, G: 1, srcModAddrByte: 0, srcSub: 0 }); // if M5.0.bit0 == 1
  const act = packCanonical({ bit31: 1, dstBit: 3, dstModAddrByte: 5, dstSub: 1, G: 3, srcModAddrByte: 0, srcSub: 0 });  // then M5.1.bit3 := 1
  const rb = { commandRuns: () => [{ entry: { groupId: 5 }, rules: [cond, act] }], commands: [cond, act] };
  const it = new Interpreter(rb);
  it.state.register(5);
  it.state.setBit(5, 0, 0, 0); it.processModule(5);
  assert.equal(it.state.getBit(5, 1, 3), 0, 'action skipped when condition false');
  it.state.setBit(5, 0, 0, 1); it.processModule(5);
  assert.equal(it.state.getBit(5, 1, 3), 1, 'action fires when condition true');
});

test('interpreter two-operand bit copy (:=) works', () => {
  // bit31=0, G=8 => bit15=1,bit11=0 => selector 2 (:=); srcBit = G&7 = 0
  const copy = packCanonical({ bit31: 0, dstBit: 2, dstModAddrByte: 9, dstSub: 4, G: 8, srcModAddrByte: 9, srcSub: 5 });
  const it = new Interpreter({ commandRuns: () => [], commands: [] });
  it.state.register(9);
  it.state.setBit(9, 5, 0, 1); // src bit 0 of sub 5
  const ok = it.execWord(9, copy);
  assert.equal(ok, true);
  assert.equal(it.state.getBit(9, 4, 2), 1, 'dst bit (sub4.bit2) copied from src (sub5.bit0)');
});
