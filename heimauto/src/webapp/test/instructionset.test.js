import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { COMMANDS, COMMAND_BY_INDEX, OPERATORS, FAMILIES, renderRule } from '../src/instructionset.js';
import { RuleBase } from '../src/hrb.js';
import { extractFields, classify } from '../src/ruleword.js';

const HRB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'RouleBase.hrb');

test('instruction set has the 99 commands of ParserV1000.exe', () => {
  assert.equal(COMMANDS.length, 99);
  assert.equal(FAMILIES.length, 9);
  assert.equal(OPERATORS.length, 13);
});

test('generated command texts match the literals in the parser binary', () => {
  // spot checks taken verbatim from ParserV1000.exe 0x004474FC..0x004480FC
  const expect = {
    0: 'MaD.SaD.BPD!=MaS.SaS.BPS',
    4: 'MaD.SaD.BPD==Bit-Konstante(0)',
    7: 'MaD.SaD.BPD:=Bit-Konstante(1)',
    8: 'MaD.SaD!=MaS.SaS',
    13: 'MaD.SaD>=MaS.SaS',
    16: 'MaD.SaD:=MaS.SaS',
    20: 'MaD.SaD^=MaS.SaS',
    22: 'MaD.SaD-=MaS.SaS',
    24: 'MaD.SaD!=Byte-Konstante',
    32: 'MaD.SaD:=Byte-Konstante',
    38: 'MaD.SaD-=Byte-Konstante',
    40: 'ST!=Zeitkonstante ss.s',
    48: 'ST:=Zeitkonstante ss.s',
    54: 'ST-=Zeitkonstante ss.s',
    56: 'LT!=Zeitkonstante mmm',
    72: 'DT!=WT, TT.MM SS:MM',
    80: 'DT:=WT, TT.MM SS:MM',
    86: 'DT-=WT, TT.MM SS:MM',
    88: 'LST!=Zeitkonstante ss.s',
    104: 'LLT!=Zeitkonstante mmm',
    118: 'LLT-=Zeitkonstante mmm',
  };
  for (const [i, t] of Object.entries(expect)) {
    assert.equal(COMMAND_BY_INDEX.get(Number(i)).text, t, `opcode ${i}`);
  }
});

test('the 20 gap slots of the 119-entry table are empty', () => {
  for (const g of [14, 15, 23, 30, 31, 39, 46, 47, 55, 62, 63, 71, 78, 79, 87, 94, 95, 103, 110, 111]) {
    assert.equal(COMMAND_BY_INDEX.has(g), false, `slot ${g} must be a gap`);
  }
});

test('every real rule renders to parser notation', () => {
  const rb = RuleBase.fromBuffer(readFileSync(HRB));
  let unknown = 0;
  for (const w of rb.commands) {
    const s = renderRule(extractFields(w), classify(w));
    assert.ok(typeof s === 'string' && s.length > 0);
    if (s.startsWith('?')) unknown++;
  }
  assert.equal(unknown, 0, 'no rule renders as unknown');
});

test('the first rule run is a time-triggered chain (semantic sanity)', () => {
  const rb = RuleBase.fromBuffer(readFileSync(HRB));
  const run = rb.commandRuns()[0];
  const src = run.rules.map((w) => renderRule(extractFields(w), classify(w)));
  assert.match(src[0], /^DT==\d\d:\d\d$/, 'starts with a DateTime condition');
  assert.match(src[1], /==Bit-Konstante\(1\)$/, 'followed by an enable-bit condition');
  assert.ok(src.slice(2).every((s) => /:=Bit-Konstante\([01]\)$/.test(s)), 'then bit assignments');
});
