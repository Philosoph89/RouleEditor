import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RuleBase } from '../src/hrb.js';
import { decode, encode, familyOf, FAMILY } from '../src/compiler.js';

const HRB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'RouleBase.hrb');

test('decode+encode round-trips every rule of RouleBase.hrb byte-exact', () => {
  const rb = RuleBase.fromBuffer(readFileSync(HRB));
  let bad = 0;
  for (const w of rb.commands) if (encode(decode(w)) !== (w >>> 0)) bad++;
  assert.equal(bad, 0, `all ${rb.commands.length} rules re-encode exactly`);
});

test('opcode -> family boundaries match the parser dispatch', () => {
  assert.equal(familyOf(0), FAMILY.BIT_BIT);
  assert.equal(familyOf(3), FAMILY.BIT_BIT);
  assert.equal(familyOf(4), FAMILY.BIT_CONST);
  assert.equal(familyOf(7), FAMILY.BIT_CONST);
  assert.equal(familyOf(8), FAMILY.BYTE_BYTE);
  assert.equal(familyOf(23), FAMILY.BYTE_BYTE);
  assert.equal(familyOf(24), FAMILY.BYTE_CONST);
  assert.equal(familyOf(40), FAMILY.ST);
  assert.equal(familyOf(56), FAMILY.LT);
  assert.equal(familyOf(72), FAMILY.DT);
  assert.equal(familyOf(88), FAMILY.LST);
  assert.equal(familyOf(104), FAMILY.LLT);
});

test('BIT_BIT encodes the operator into bit15/bit11 as the original does', () => {
  for (let op = 0; op <= 3; op++) {
    const w = encode({ opcode: op, family: FAMILY.BIT_BIT, dstBit: 2, dstMod: 0x10, dstSub: 3, srcBit: 1, srcMod: 0x11, srcSub: 4 });
    assert.equal((w >>> 31) & 1, 0, 'bit31 clear for BIT_BIT');
    assert.equal((((w >>> 15) & 1) * 2) + ((w >>> 11) & 1), op, 'operator selector');
    assert.equal(decode(w).opcode, op);
  }
});

test('value families set bit31 and carry the operator in bits 28..30', () => {
  const w = encode({ opcode: 26, family: FAMILY.BYTE_CONST, dstMod: 0x1c, dstSub: 5, const8: 0x2a });
  assert.equal((w >>> 31) & 1, 1);
  const d = decode(w);
  assert.equal(d.opcode, 26);
  assert.equal(d.const8, 0x2a);
});

test('DT fields round-trip (weekday/hour/minute)', () => {
  const w = encode({ opcode: 73, family: FAMILY.DT, wd: 0, x: 7, weekday: 3, hour: 5, minute: 30 });
  const d = decode(w);
  assert.equal(d.opcode, 73);
  assert.equal(d.hour, 5);
  assert.equal(d.minute, 30);
  assert.equal(d.weekday, 3);
});

import { compileLine, compileText } from '../src/compiler.js';
import { renderFromDecoded } from '../src/instructionset.js';

test('word -> TEXT -> word round-trips EVERY rule byte-exact', () => {
  const rb = RuleBase.fromBuffer(readFileSync(HRB));
  let bad = 0;
  for (const w of rb.commands) {
    if (encode(compileLine(renderFromDecoded(decode(w)))) !== (w >>> 0)) bad++;
  }
  assert.equal(bad, 0, `all ${rb.commands.length} rules survive word->text->word`);
});

test('DT carries weekday, day, month and wildcards', () => {
  const w = encode(compileLine('DT==Sa, 24.12 18:30;'));
  const d = decode(w);
  assert.equal(d.family, 'DT');
  assert.equal(d.weekday, 6, 'Sa');
  assert.equal(d.day, 24);
  assert.equal(d.month, 12);
  assert.equal(d.hour, 18);
  assert.equal(d.minute, 30);
  // all-wildcard form
  const d2 = decode(encode(compileLine('DT==*, *.* 05:00;')));
  assert.equal(d2.weekday, 7, 'weekday wildcard');
  assert.equal(d2.day, 0);
  assert.equal(d2.month, 0);
  assert.equal(d2.hour, 5);
});

test('bit 11 distinguishes ST/LST and LT/LLT', () => {
  const st = encode(compileLine('ST3:=6.0;'));
  const lst = encode(compileLine('LST3:=6.0;'));
  assert.equal((st >>> 11) & 1, 0, 'ST has the load flag clear');
  assert.equal((lst >>> 11) & 1, 1, 'LST has the load flag set');
  assert.equal(decode(st).family, 'ST');
  assert.equal(decode(lst).family, 'LST');
  assert.equal(decode(encode(compileLine('LLT2:=30;'))).family, 'LLT');
  assert.equal(decode(encode(compileLine('LT2:=30;'))).family, 'LT');
});

test('compileText reports errors per line and skips comments', () => {
  const r = compileText('// Kommentar\n10.7.5==Bit-Konstante(1);\n\nquatsch;\nST9:=6.0;');
  assert.equal(r.words.length, 2, 'two rules compiled');
  assert.equal(r.errors.length, 1, 'one bad line reported');
  assert.equal(r.errors[0].line, 4);
});

test('compiled timer text encodes number and value as the original does', () => {
  const w = encode(compileLine('ST9:=6.0;'));
  const d = decode(w);
  assert.equal(d.family, 'ST');
  assert.equal(d.hi, 9, 'timer number');
  assert.equal(d.time, 12, '6.0 s stored as 12 half-seconds');
});
