// Authoritative HomeBus rule instruction set.
//
// Source: ParserV1000.exe ("Code Parser V1.000 Roulebase Version 2.1"), the
// original text->RouleBase compiler. Its command table is stored contiguously
// as Delphi string literals at 0x004474FC..0x004480FC and is the definitive
// specification: 99 commands in 9 operand families. The RouleEditor's 83-entry
// ModEvCmdStr dropdown is the same list padded into 8-aligned groups (which is
// why it shows "---------------" gaps at 14,15,23,30,31,39,46,47,55,62,63,71,78,79).
//
// The 13 operators, in opcode order (from the parser's per-family tables):
export const OPERATORS = ['!=', '==', '>', '=<', '<', '>=', ':=', '~=', '&=', '|=', '^=', '+=', '-='];

// The first six are the comparison operators and match, one-for-one, the 6-case
// comparator helpers FUN_0046AFC0 / FUN_0046B050 in RouleEditorV2103.exe
// (op 0..5 = != == > =< < >=). The remaining seven are assignments.
export const COMPARISONS = OPERATORS.slice(0, 6);
export const ASSIGNMENTS = OPERATORS.slice(6);

// Operand families, in the parser's order. `ops` is how many of OPERATORS the
// family supports; `first` is the opcode index of its first entry.
export const FAMILIES = [
  { key: 'BIT_BIT',   first: 0,  ops: 4,  dst: 'MaD.SaD.BPD', src: 'MaS.SaS.BPS',
    operators: ['!=', '==', ':=', '~='], note: 'Bit gegen Bit' },
  { key: 'BIT_CONST', first: 4,  ops: 4,  dst: 'MaD.SaD.BPD', src: 'Bit-Konstante',
    operators: ['==0', '==1', ':=0', ':=1'], note: 'Bit gegen Konstante 0/1' },
  { key: 'BYTE_BYTE', first: 8,  ops: 13, sparse: true, dst: 'MaD.SaD', src: 'MaS.SaS',
    note: 'Byte gegen Byte' },
  { key: 'BYTE_CONST', first: 24, ops: 13, sparse: true, dst: 'MaD.SaD', src: 'Byte-Konstante',
    note: 'Byte gegen Konstante [0..FF]' },
  { key: 'ST',  first: 40, ops: 13, sparse: true, dst: 'ST',  src: 'Zeitkonstante ss.s',
    note: 'ShortTimer, 0..127.5 s in 0,5-s-Schritten' },
  { key: 'LT',  first: 56, ops: 13, sparse: true, dst: 'LT',  src: 'Zeitkonstante mmm',
    note: 'LongTimer, 0..255 Minuten' },
  { key: 'DT',  first: 72, ops: 13, sparse: true, dst: 'DT',  src: 'WT, TT.MM SS:MM',
    note: 'DateTime (Wochentag, Tag.Monat Stunde:Minute)' },
  { key: 'LST', first: 88, ops: 13, sparse: true, dst: 'LST', src: 'Zeitkonstante ss.s',
    note: 'Load ShortTimer' },
  { key: 'LLT', first: 104, ops: 13, sparse: true, dst: 'LLT', src: 'Zeitkonstante mmm',
    note: 'Load LongTimer' },
];

// Build the flat 99-entry command table exactly as the parser stores it.
export const COMMANDS = (() => {
  const out = [];
  for (const f of FAMILIES) {
    const ops = f.operators || OPERATORS.slice(0, f.ops);
    for (let i = 0; i < f.ops; i++) {
      const op = ops[i];
      // Sparse families occupy a 16-slot group: compares at +0..5, gap +6/+7,
      // assignments at +8..14, gap +15 (exactly the NULL holes in the parser's
      // 119-entry table at 0x00449B14).
      const slot = f.sparse ? (i <= 5 ? i : i + 2) : i;
      let text;
      if (f.key === 'BIT_CONST') {
        // "MaD.SaD.BPD==Bit-Konstante(0)" etc.
        const sym = op.slice(0, 2);          // '==' or ':='
        const val = op.slice(2);             // '0' or '1'
        text = `${f.dst}${sym}Bit-Konstante(${val})`;
      } else {
        text = `${f.dst}${op}${f.src}`;
      }
      out.push({ index: f.first + slot, family: f.key, operator: op, text, note: f.note });
    }
  }
  return out;
})();

export const COMMAND_BY_INDEX = new Map(COMMANDS.map((c) => [c.index, c]));

// --- operand syntax, from GetDstObjectType / GetSrcObjectType --------------
// Destination object keywords the parser accepts:
export const DST_KEYWORDS = ['MaD.SaD.BPD', 'MaD.SaD', 'ST', 'LST', 'LT', 'LLT', 'DT', 'DATETIME', 'DATE', 'TIME'];
// Source object forms:
export const SRC_FORMS = [
  'MaS.SaS.BPS', 'MaS.SaS', 'Byte-Konstante', 'Bit-Konstante(0|1)',
  'Zeitkonstante ss.s', 'Zeitkonstante mmm', 'WT, TT.MM SS:MM',
];

// Validation ranges enforced by the parser (from its error messages):
export const RANGES = {
  modulAddress: [0x00, 0xff],   // "Moduladresse im Bereich [0..FF]"
  subAddressDst: [0x0, 0xf],    // "Modulsubadresse im Bereich [0..F]"
  subAddressSrc: [0x0, 0x7],    // "Modulsubadresse im Bereich [0..7]"
  bitPosition: [0, 7],          // "Bitposition im Bereich [0..7]"
  bitConst: [0, 1],             // "Bitkonstante im Bereich [0..1]"
  byteConst: [0x00, 0xff],      // "Bytekonstante im Bereich [0..FF]"
  timerNumber: [0, 15],         // "Timernummer im Bereich [0..15]"
  shortTime: [0, 127.5],        // "Zeitwert im Bereich [0..127.5]"
  longTime: [0, 255],           // "Zeitwert im Bereich [0..255]"
  day: [1, 31], month: [1, 12], hour: [0, 23], minute: [0, 59],
};

// Lexical details from the parser: comments start with '//', statements end
// with ';', a label/target is introduced with ':'; spaces are stripped
// (TCheckRoules.DelSpaces) before tokenising.
export const SYNTAX = {
  comment: '//',
  statementEnd: ';',
  labelSep: ':',
  hexPrefix: '$',            // Delphi-style hex literals
  wildcard: '*',             // accepted for DateTime fields
  weekdays: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
};

// ---------------------------------------------------------------------------
// Render a decoded rule word in the original parser notation.
// `fields` comes from ruleword.extractFields, `cls` from ruleword.classify.
export function renderRule(fields, cls) {
  const f = fields;
  const hexb = (n) => n.toString(16).toUpperCase().padStart(2, '0');
  const dstBit = `${hexb(f.dstModAddrByte)}.${f.dstSub.toString(16).toUpperCase()}.${f.dstBit}`;
  const dstByte = `${hexb(f.dstModAddrByte)}.${f.dstSub.toString(16).toUpperCase()}`;
  const srcBit = `${hexb(f.srcModAddrByte)}.${f.srcSub.toString(16).toUpperCase()}.${f.srcBit}`;
  const srcByte = `${hexb(f.srcModAddrByte)}.${f.srcSub.toString(16).toUpperCase()}`;
  const cmpOp = OPERATORS[f.dstBit] || '?';

  switch (cls.kind) {
    case 'bit-2op':
      return `${dstBit}${cls.operator}${srcBit}`;
    case 'bit-const': {
      // G0..G3 -> ==0 ==1 :=0 :=1
      const m = { 0: '==0', 1: '==1', 2: ':=0', 3: ':=1' }[f.G] || '?';
      return `${dstBit}${m.slice(0, 2)}Bit-Konstante(${m.slice(2)})`;
    }
    case 'cmp':
      return cls.srcMode === 'k'
        ? `${dstByte}${cmpOp}$${hexb(f.const8)}`
        : `${dstByte}${cmpOp}${srcByte}`;
    case 'ST':
      return `ST${cmpOp}${(f.timerPreset / 10).toFixed(1)}`;   // tenths of a second
    case 'LT':
      return `LT${cmpOp}${f.timerPreset}`;                      // minutes
    case 'DT': {
      const h = f.dtHour < 24 ? String(f.dtHour).padStart(2, '0') : '*';
      const mi = f.dtMinSec < 60 ? String(f.dtMinSec).padStart(2, '0') : '*';
      return `DT${cmpOp}${h}:${mi}`;
    }
    default:
      return `?${cls.kind}`;
  }
}

// ---------------------------------------------------------------------------
// Render a rule from the VERIFIED compiler decode (src/compiler.js). This is
// the authoritative path: the opcode comes from the exact inverse of the
// original encoder, so the emitted text is the command the parser would accept.
import { FAMILY } from './compiler.js';

const hx2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const hx1 = (n) => n.toString(16).toUpperCase();

export function renderFromDecoded(d) {
  const cmd = COMMAND_BY_INDEX.get(d.opcode);
  const opTxt = cmd ? cmd.operator : `op${d.opcode}`;
  switch (d.family) {
    case FAMILY.BIT_BIT:
      return `${hx2(d.dstMod)}.${hx1(d.dstSub)}.${d.dstBit}${opTxt}${hx2(d.srcMod)}.${hx1(d.srcSub)}.${d.srcBit}`;
    case FAMILY.BIT_CONST: {
      const sym = opTxt.slice(0, 2), val = opTxt.slice(2);
      return `${hx2(d.dstMod)}.${hx1(d.dstSub)}.${d.dstBit}${sym}Bit-Konstante(${val})`;
    }
    case FAMILY.BYTE_BYTE:
      return `${hx2(d.dstMod)}.${hx1(d.dstSub)}${opTxt}${hx2(d.srcMod)}.${hx1(d.srcSub)}`;
    case FAMILY.BYTE_CONST:
      return `${hx2(d.dstMod)}.${hx1(d.dstSub)}${opTxt}$${hx2(d.const8)}`;
    case FAMILY.ST: case FAMILY.LST:
      // <family><Timernummer> op ss.s ; the parser stores seconds*2 (0,5-s-Schritte)
      return `${d.family}${d.hi}${opTxt}${(d.time / 2).toFixed(1)}`;
    case FAMILY.LT: case FAMILY.LLT:
      return `${d.family}${d.hi}${opTxt}${d.time}`;
    case FAMILY.DT: {
      // Original notation: WT, TT.MM SS:MM  (wildcards printed as '*')
      const h = d.hour < 24 ? String(d.hour).padStart(2, '0') : '*';
      const mi = d.minute < 60 ? String(d.minute).padStart(2, '0') : '*';
      const wd = d.weekday <= 6 ? SYNTAX.weekdays[d.weekday] : '*';
      const dd = d.day > 0 ? String(d.day).padStart(2, '0') : '*';
      const mo = d.month > 0 ? String(d.month).padStart(2, '0') : '*';
      return `DT${opTxt}${wd}, ${dd}.${mo} ${h}:${mi}`;
    }
    default:
      return `op${d.opcode}`;
  }
}
