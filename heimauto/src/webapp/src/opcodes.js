// HomeBus rule opcode table and 32-bit rule-word codec.
//
// Reverse-engineered from RouleEditorV2103.exe:
//   * opcode list  -> TEditForm ModEvCmdStr dropdown (83 entries, indices 00..82)
//   * bit layout   -> TSimulationForm.RBExecCmd (0x0046929C) + disassembler 0x00460CDC
//
// Rule word (32 bit, MSB..LSB):
//   bit 31      : 0 = module/bit event, 1 = timer/date event (ST/LT/DT)
//   bits 30..28 : destination bit position        (dstBit, 3 bit)
//   bits 27..24 : destination sub-address          (dstSub, 4 bit)
//   bits 23..21 : source bit position              (srcBit, 3 bit)
//   bits 20..16 : opcode / constant field          (op5,    5 bit)
//   bits 15..12 : source sub-address               (srcSub, 4 bit)
//   bits 11..0  : operand / module-address region  (operand12, 12 bit)

// The opcode index encoded in the editor. `null` entries are the reserved
// gaps (14,15,23,30,31,39,46,47,55,62,63,71,78,79) that the editor shows as
// "---------------".
export const OPCODES = [
  'Ma.Sa.Bit != Ma.Sa.Bit', 'Ma.Sa.Bit == Ma.Sa.Bit', 'Ma.Sa.Bit := Ma.Sa.Bit',
  'Ma.Sa.Bit ~= Ma.Sa.Bit', 'Ma.Sa.Bit == 0', 'Ma.Sa.Bit == 1',
  'Ma.Sa.Bit := 0', 'Ma.Sa.Bit := 1',
  'Ma.Sa != Ma.Sa', 'Ma.Sa == Ma.Sa', 'Ma.Sa > Ma.Sa', 'Ma.Sa =< Ma.Sa',
  'Ma.Sa < Ma.Sa', 'Ma.Sa >= Ma.Sa', null, null,
  'Ma.Sa := Ma.Sa', 'Ma.Sa ~= Ma.Sa', 'Ma.Sa &= Ma.Sa', 'Ma.Sa |= Ma.Sa',
  'Ma.Sa ^= Ma.Sa', 'Ma.Sa += Ma.Sa', 'Ma.Sa -= Ma.Sa', null,
  'Ma.Sa != k', 'Ma.Sa == k', 'Ma.Sa > k', 'Ma.Sa =< k', 'Ma.Sa < k',
  'Ma.Sa >= k', null, null,
  'Ma.Sa := k', 'Ma.Sa ~= k', 'Ma.Sa &= k', 'Ma.Sa |= k', 'Ma.Sa ^= k',
  'Ma.Sa += k', 'Ma.Sa -= k', null,
  'ST != k', 'ST == k', 'ST > k', 'ST =< k', 'ST < k', 'ST >= k', null, null,
  'ST := k', 'ST ~= k', 'ST &= k', 'ST |= k', 'ST ^= k', 'ST += k', 'ST -= k', null,
  'LT != k', 'LT == k', 'LT > k', 'LT =< k', 'LT < k', 'LT >= k', null, null,
  'LT := k', 'LT ~= k', 'LT &= k', 'LT |= k', 'LT ^= k', 'LT += k', 'LT -= k', null,
  'DT != Date+Time', 'DT == Date+Time', 'DT > Date+Time', 'DT =< Date+Time',
  'DT < Date+Time', 'DT >= Date+Time', null, null,
  'DT := Date+Time', 'DT += Date+Time', 'DT -= Date+Time',
];

// Which class an opcode index belongs to (drives the UI + interpreter).
export function opcodeClass(idx) {
  if (idx <= 7) return 'BIT';        // module bit event
  if (idx <= 22) return 'BYTE';      // module byte, source = another module
  if (idx <= 38) return 'BYTE_K';    // module byte, source = constant
  if (idx <= 54) return 'ST';        // short timer
  if (idx <= 70) return 'LT';        // long timer
  return 'DT';                       // date/time
}

export const RESERVED = new Set([14, 15, 23, 30, 31, 39, 46, 47, 55, 62, 63, 71, 78, 79]);

// --- raw 32-bit field access ------------------------------------------------
export function decodeRule(word) {
  const w = word >>> 0;
  return {
    raw: w,
    hex: '0x' + w.toString(16).toUpperCase().padStart(8, '0'),
    isTimerEvent: Boolean(w & 0x80000000),
    dstBit: (w >>> 28) & 0x7,
    dstSub: (w >>> 24) & 0xf,
    srcBit: (w >>> 21) & 0x7,
    op5: (w >>> 16) & 0x1f,
    srcSub: (w >>> 12) & 0xf,
    operand12: w & 0xfff,
    moduleHi: (w >>> 24) & 0xf,
  };
}

export function encodeRule(f) {
  const w =
    ((f.isTimerEvent ? 1 : 0) << 31) |
    ((f.dstBit & 0x7) << 28) |
    ((f.dstSub & 0xf) << 24) |
    ((f.srcBit & 0x7) << 21) |
    ((f.op5 & 0x1f) << 16) |
    ((f.srcSub & 0xf) << 12) |
    (f.operand12 & 0xfff);
  return w >>> 0;
}

// Classify a rule word into the fields that are RELIABLY recoverable from the
// firmware (verified against RBExecCmd, 0x0046929C):
//
//   * event class  : bit 31   (0 = module event, 1 = short/long-timer or
//                              date-time event)
//   * module opGroup: for module events, ((w>>15)&1)*2 + ((w>>11)&1)  -> 0..3
//                     (RBExecCmd computes exactly this as its branch selector)
//   * timer opSel  : for timer/date events, (w>>12)&0xF  -> 0..12
//                     (RBExecCmd's switch selector in the timer branch)
//
// The full 83-way mnemonic (the editor's ModEvCmdStr list) is NOT reconstructed
// here: it is spread across several bit-fields and its exact per-opcode operand
// routing lives inside the firmware interpreter. The raw word and the bit-fields
// below are authoritative and round-trip byte-exact; the mnemonic table
// (OPCODES) is provided as an instruction-set reference.
export function classifyRule(word) {
  const w = word >>> 0;
  const isTimer = Boolean(w & 0x80000000);
  if (!isTimer) {
    const group = (((w >>> 15) & 1) * 2) + ((w >>> 11) & 1);
    return { klass: 'Modul', selector: group, label: `Modul · Gruppe ${group}` };
  }
  const sel = (w >>> 12) & 0xf;
  return { klass: 'Timer/DT', selector: sel, label: `Timer/DT · Sel ${sel}` };
}

export function describeRule(word) {
  const d = decodeRule(word);
  const c = classifyRule(word);
  return `${d.hex} ${c.label} dstSub=${d.dstSub} dstBit=${d.dstBit} `
    + `srcSub=${d.srcSub} srcBit=${d.srcBit} op12=0x${d.operand12.toString(16).toUpperCase().padStart(3, '0')}`;
}
