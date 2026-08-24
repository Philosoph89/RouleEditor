// Exact decoder for a 32-bit HomeBus rule word.
//
// Every field below is transcribed 1:1 from the field-extraction prologue of
// TSimulationForm.RBExecCmd (0x004692C0), read at the assembly level
// (re/ghidra/asm_dump.txt). Register convention (Delphi):
//   EAX = Self, EDX = rule word (W), ECX = module base address (MB, 16-bit).
//
// Local slots in the original (for cross-reference with the asm):
//   [-0xc]/[-0xe] A   = (W>>28)&7      destination bit position
//   [-0x11]/[-0x12]   = (W>>24)&0xf    destination sub high nibble (module addr)
//   [-0x21] D         = (W>>20)&0xff   destination module-address byte (map index)
//   [-0x22] E         = (W>>16)&0xf    destination sub-address (0..15)
//   [-0xf]  G         = (W>>12)&0xf    operation category (switch selector)
//   [-0xd]  H         = (W>>12)&7      source bit position
//   [-0x23] J         = (W>>4)&0xff    source module-address byte (map index)
//   [-0x24] K         = (W)&0xf        source sub-address (0..15)
//   [-0x10] L         = (W)&0xff       8-bit constant / value
//   [-0x32] M         = ((W>>11)&1)==0 source = Ma.Sa (true) vs constant k (false-> actually see note)
//   [-0x1c]           = (MB&0x7ff0) + ((W>>24)&0xf)   full destination module address
//   [-0x13] N         = (W>>21)&7
//   [-0x14]           = (W>>16)&0x1f   5-bit constant / timer number
//   [-0x15]           = (W>>6)&0x1f    DateTime hour field (<24) else '*'
//   [-0x16]           = (W)&0x3f       DateTime minute/second field (<60) else '*'
//
// Bit 31 selects the top-level branch:
//   bit31 == 0 -> two-operand bit op (Ma.Sa.Bit OP Ma.Sa.Bit), operator =
//                 ((W>>15)&1)*2 + ((W>>11)&1)  ->  0:!=  1:==  2::=  3:~=
//   bit31 == 1 -> switch(G): G 0..3 are single-bit-constant ops (verified),
//                 G 4..12 are byte / ShortTimer / LongTimer / DateTime ops
//                 (category verified; exact operator within a category is
//                 resolved by the interpreter's comparator helper 0x46B050 and
//                 is still being transcribed — see STATUS).

export const BITOP_2OPERAND = ['!=', '==', ':=', '~=']; // bit31==0 selector

export function extractFields(word, moduleBase = 0) {
  const W = word >>> 0;
  return {
    raw: W,
    hex: '0x' + W.toString(16).toUpperCase().padStart(8, '0'),
    bit31: (W >>> 31) & 1,
    // destination
    dstBit: (W >>> 28) & 7,          // A
    dstSubHi: (W >>> 24) & 0xf,      // contributes to module address
    dstModAddrByte: (W >>> 20) & 0xff, // D
    dstSub: (W >>> 16) & 0xf,        // E
    dstModuleAddr: ((moduleBase & 0x7ff0) + ((W >>> 24) & 0xf)) & 0xffff, // [-0x1c]
    // category / source
    G: (W >>> 12) & 0xf,             // operation category
    srcBit: (W >>> 12) & 7,          // H
    srcModAddrByte: (W >>> 4) & 0xff, // J
    srcSub: W & 0xf,                 // K
    const8: W & 0xff,                // L
    const5: (W >>> 16) & 0x1f,       // timer number / small constant
    n3: (W >>> 21) & 7,              // N
    bit11: (W >>> 11) & 1,           // source-mode / sign flag
    bit15: (W >>> 15) & 1,
    // DateTime sub-fields
    dtHour: (W >>> 6) & 0x1f,        // <24 else '*'
    dtMinSec: W & 0x3f,              // <60 else '*'
    // Timer preset, transcribed verbatim from the prologue at 0x00469370:
    //   local_20 = (((W>>16)&0xff) + (W & 0x1ff)) * 5
    timerPreset: ((((W >>> 16) & 0xff) + (W & 0x1ff)) * 5) & 0xffff,
    // Timer operand as actually stored in the word (verified against the real
    // rule base: "LST9 := 30.0" -> 60, "LST9 =< 29.0" -> 58, i.e. ShortTimer
    // units are 0.5 s and LongTimer units are minutes).
    timerNr: (W >>> 24) & 0xf,
    timerValue: (W >>> 16) & 0xff,
  };
}

// Byte comparator operators, transcribed from FUN_0046B050 (the CMP/SETcc
// dispatch). Operator index = (W>>28)&7 (the top 3 bits, which carry no bit
// position for byte ops). Values 0..5 are used; 6..7 fall through to "false".
export const CMP_OPS = ['!=', '==', '>', '=<', '<', '>='];

// Operation category for bit31==1, keyed by G = (W>>12)&0xf.
// Verified against the RBExecCmd switch bodies (re/ghidra/asm_rbexec.txt) and
// the two comparator helpers FUN_0046AFC0 / FUN_0046B050 (identical CMP/SETcc
// dispatch, operator index 0..5 = != == > =< < >=):
//   G0 SETZ(bit==0)   G1 SETNZ(bit==1)   G2 AND=>bit:=0   G3 OR=>bit:=1
//   G4..G9  value compares  (operator = (W>>28)&7, source Ma.Sa or k via bit11)
//   G10 ShortTimer compare   G11 LongTimer compare   G12 DateTime compare
// For G0..G3 the (W>>28)&7 field is the *bit index*, not an operator.
const G_CATEGORY = {
  0: { op: 4, name: 'Ma.Sa.Bit == 0', kind: 'bit-const', verified: true },
  1: { op: 5, name: 'Ma.Sa.Bit == 1', kind: 'bit-const', verified: true },
  2: { op: 6, name: 'Ma.Sa.Bit := 0', kind: 'bit-const', verified: true },
  3: { op: 7, name: 'Ma.Sa.Bit := 1', kind: 'bit-const', verified: true },
  4: { kind: 'cmp', verified: true },
  5: { kind: 'cmp', verified: true },
  6: { kind: 'cmp', verified: true },
  7: { kind: 'cmp', verified: true },
  8: { kind: 'cmp', verified: true },
  9: { kind: 'cmp', verified: true },
  10: { kind: 'ST', verified: true },
  11: { kind: 'LT', verified: true },
  12: { kind: 'DT', verified: true },
};

// Classify a rule word into { op, name, kind, verified, srcMode, operator }.
// `op` is the editor opcode index (0..82) when known.
export function classify(word) {
  const f = extractFields(word);
  if (f.bit31 === 0) {
    const sel = f.bit15 * 2 + f.bit11;
    return {
      op: sel, // opcodes 0..3
      name: `Ma.Sa.Bit ${BITOP_2OPERAND[sel]} Ma.Sa.Bit`,
      kind: 'bit-2op',
      operator: BITOP_2OPERAND[sel],
      srcMode: 'Ma.Sa',
      verified: true,
    };
  }
  const cat = G_CATEGORY[f.G] || { name: `G${f.G}`, kind: 'unknown', verified: false };
  const srcMode = f.bit11 ? 'k' : 'Ma.Sa';
  const out = { op: cat.op ?? null, name: cat.name, kind: cat.kind, srcMode, G: f.G, verified: Boolean(cat.verified) };
  const opIdx = (word >>> 28) & 7;
  const operator = CMP_OPS[opIdx];
  if (cat.kind === 'cmp') {
    out.operator = operator ?? `?${opIdx}`;
    out.name = `Ma.Sa ${out.operator} ${srcMode === 'k' ? 'k' : 'Ma.Sa'}`;
    // editor opcode index: byte compares are 8..13 (Ma.Sa) / 24..29 (k)
    if (operator !== undefined) out.op = (srcMode === 'k' ? 24 : 8) + opIdx;
  } else if (cat.kind === 'ST' || cat.kind === 'LT' || cat.kind === 'DT') {
    out.operator = operator ?? `?${opIdx}`;
    const rhs = cat.kind === 'DT' ? 'Date+Time' : 'k';
    out.name = `${cat.kind} ${out.operator} ${rhs}`;
    const base = cat.kind === 'ST' ? 40 : cat.kind === 'LT' ? 56 : 72;
    if (operator !== undefined) out.op = base + opIdx;
  }
  return out;
}

export function describe(word, moduleBase = 0) {
  const f = extractFields(word, moduleBase);
  const c = classify(word);
  const dst = `M${f.dstModuleAddr}.${f.dstSub}${c.kind.startsWith('bit') ? '.' + f.dstBit : ''}`;
  const src = c.srcMode === 'k'
    ? `k=${f.const8}`
    : `M(${f.srcModAddrByte}).${f.srcSub}${c.kind === 'bit-2op' ? '.' + f.srcBit : ''}`;
  return `${f.hex}  ${c.name}   dst=${dst} src=${src}`;
}

// Canonical, non-overlapping 7-field decomposition of the 32-bit word.
// Every semantic field above is a view onto these bits; packing them back
// reproduces the word byte-exact (validated against all rules in RouleBase.hrb).
//
//   bit31 | dstBit(30..28) | dstModAddrByte(27..20) | dstSub(19..16)
//         | G(15..12) | srcModAddrByte(11..4) | srcSub(3..0)
export function canonicalFields(word) {
  const W = word >>> 0;
  return {
    bit31: (W >>> 31) & 1,
    dstBit: (W >>> 28) & 7,
    dstModAddrByte: (W >>> 20) & 0xff,
    dstSub: (W >>> 16) & 0xf,
    G: (W >>> 12) & 0xf,
    srcModAddrByte: (W >>> 4) & 0xff,
    srcSub: W & 0xf,
  };
}

export function packCanonical(c) {
  return (
    ((c.bit31 & 1) * 0x80000000) +   // avoid 32-bit sign issues with <<31
    (((c.dstBit & 7) << 28) >>> 0) +
    ((c.dstModAddrByte & 0xff) << 20) +
    ((c.dstSub & 0xf) << 16) +
    ((c.G & 0xf) << 12) +
    ((c.srcModAddrByte & 0xff) << 4) +
    (c.srcSub & 0xf)
  ) >>> 0;
}
