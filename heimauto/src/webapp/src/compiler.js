// Rule compiler / decompiler: text <-> 32-bit rule word.
//
// The bit assembly is transcribed instruction-for-instruction from the original
// compiler ParserV1000.exe, function FUN_00443770 (called from FUN_00448114
// after the command text has been matched against the 119-slot table at
// 0x00449B14, count at 0x00449CF4).
//
// Per-family assembly as emitted by the original (verified in asm):
//
//   op 0-3    BIT_BIT     bit31=0
//     dstBit<<28 | dstMod<<20 | dstSub<<16 | (op>>1)<<15 | srcBit<<12
//     | (op&1)<<11 | (srcMod & 0x7F)<<4 | srcSub
//   op 4-7    BIT_CONST   bit31=1
//     dstBit<<28 | dstMod<<20 | dstSub<<16 | G<<12
//   op 8-23   BYTE_BYTE   bit31=1
//     (op&7)<<28 | dstMod<<20 | dstSub<<16 | G<<12 | srcMod<<4 | srcSub
//   op 24-39  BYTE_CONST  bit31=1
//     (op&7)<<28 | dstMod<<20 | dstSub<<16 | G<<12 | const8
//   op 40-55  ST | 56-71 LT | 88-103 LST | 104-119 LLT   bit31=1
//     (op&7)<<28 | hi<<24 | (t & 0xFF)<<16 | G<<12 | (t>>8)
//     (LST/LLT additionally set bit 11 -> the original ORs 0x80000800)
//   op 72-82  DT          bit31=1
//     (op&7)<<28 | wd<<24 | x<<21 | weekday<<16 | G<<12 | hour<<6 | minute
//
// where G = (op>>3)+3 for every family from BYTE_BYTE onwards.
//
// IMPORTANT — encoder generations: in the shipped RouleBase.hrb the BIT_CONST
// family uses G = op-4 (i.e. G 0..3) while ParserV1000.exe emits G = op (4..7).
// Everything else matches. The shipped file therefore predates this parser
// build (or came from the editor's own encoder). `decode()` accepts both and
// `encode()` follows the shipped-file convention by default so that a decoded
// rule base re-encodes byte-exact; pass {parserGeneration:true} for the
// ParserV1000 convention.

export const FAMILY = {
  BIT_BIT: 'BIT_BIT',
  BIT_CONST: 'BIT_CONST',
  BYTE_BYTE: 'BYTE_BYTE',
  BYTE_CONST: 'BYTE_CONST',
  ST: 'ST', LT: 'LT', DT: 'DT', LST: 'LST', LLT: 'LLT',
};

// opcode -> family, from the parser's dispatch boundaries (FUN_00443770).
export function familyOf(op) {
  if (op <= 3) return FAMILY.BIT_BIT;
  if (op <= 7) return FAMILY.BIT_CONST;
  if (op <= 23) return FAMILY.BYTE_BYTE;
  if (op <= 39) return FAMILY.BYTE_CONST;
  if (op <= 55) return FAMILY.ST;
  if (op <= 71) return FAMILY.LT;
  if (op <= 82) return FAMILY.DT;
  if (op <= 103) return FAMILY.LST;
  return FAMILY.LLT;
}

const G_OF = (op) => ((op >>> 3) + 3) & 0xf;
const FAM_BASE = { BIT_BIT: 0, BIT_CONST: 4, BYTE_BYTE: 8, BYTE_CONST: 24,
                   ST: 40, LT: 56, DT: 72, LST: 88, LLT: 104 };
const famBaseOf = (fam) => FAM_BASE[fam];

// --- decode ---------------------------------------------------------------
export function decode(word) {
  const W = word >>> 0;
  const bit31 = (W >>> 31) & 1;
  const b2830 = (W >>> 28) & 7;
  const dstMod = (W >>> 20) & 0xff;
  const dstSub = (W >>> 16) & 0xf;
  const G = (W >>> 12) & 0xf;

  if (!bit31) {
    // BIT_BIT: operator selector = bit15*2 + bit11
    const op = (((W >>> 15) & 1) * 2) + ((W >>> 11) & 1);
    return {
      opcode: op, family: FAMILY.BIT_BIT,
      dstMod, dstSub, dstBit: b2830,
      srcMod: (W >>> 4) & 0x7f, srcSub: W & 0xf, srcBit: (W >>> 12) & 7,
    };
  }

  if (G < 4) {
    // BIT_CONST, shipped-file generation (G = op-4)
    return { opcode: G + 4, family: FAMILY.BIT_CONST, dstMod, dstSub, dstBit: b2830, generation: 'file' };
  }
  // NOTE: G >= 4 is never BIT_CONST in this file generation. A word with
  // G >= 4 and empty low bits is a BYTE_CONST comparison against the constant 0
  // (byte-const leaves bits 0..11 zero when the constant is zero), so it must
  // fall through to the family decode below.

  let op = ((G - 3) * 8) + b2830;
  // Bit 11 is the "Load" flag of the timer families in this file generation:
  // G8/G9 are ST (bit11=0) or LST (bit11=1); G10/G11 are LT or LLT. The later
  // ParserV1000 build moved LST/LLT to their own G values instead.
  const loadFlag = (W >>> 11) & 1;
  if (loadFlag && G >= 8 && G <= 11) op += 48;   // 40->88, 48->96, 56->104, 64->112
  const fam = familyOf(op);
  const base = { opcode: op, family: fam };
  switch (fam) {
    case FAMILY.BYTE_BYTE:
      return { ...base, dstMod, dstSub, srcMod: (W >>> 4) & 0xff, srcSub: W & 0xf };
    case FAMILY.BYTE_CONST:
      return { ...base, dstMod, dstSub, const8: W & 0xff };
    case FAMILY.ST: case FAMILY.LT: case FAMILY.LST: case FAMILY.LLT:
      // hi (bits 24..27) = timer number, time value = byte at bits 16..23.
      return { ...base, hi: (W >>> 24) & 0xf, time: (W >>> 16) & 0xff };
    case FAMILY.DT:
      // month bits 24..27 (0 = *), weekday bits 21..23 (7 = *),
      // day bits 16..20 (0 = *), hour bits 6..10 (24 = *), minute bits 0..5 (60 = *)
      return { ...base, month: (W >>> 24) & 0xf, weekday: (W >>> 21) & 7,
               day: (W >>> 16) & 0x1f, hour: (W >>> 6) & 0x1f, minute: W & 0x3f };
    default:
      return base;
  }
}

// --- encode ---------------------------------------------------------------
export function encode(r, { parserGeneration = false } = {}) {
  const op = r.opcode >>> 0;
  const fam = r.family || familyOf(op);
  const u = (v) => (v >>> 0);
  let W = 0;

  switch (fam) {
    case FAMILY.BIT_BIT:
      W = ((r.dstBit & 7) << 28) | ((r.dstMod & 0xff) << 20) | ((r.dstSub & 0xf) << 16)
        | (((op >>> 1) & 1) << 15) | ((r.srcBit & 7) << 12) | ((op & 1) << 11)
        | ((r.srcMod & 0x7f) << 4) | (r.srcSub & 0xf);
      return u(W);

    case FAMILY.BIT_CONST: {
      const G = parserGeneration ? (op & 0xf) : ((op - 4) & 0xf);
      W = 0x80000000 | ((r.dstBit & 7) << 28) | ((r.dstMod & 0xff) << 20)
        | ((r.dstSub & 0xf) << 16) | (G << 12);
      return u(W);
    }

    case FAMILY.BYTE_BYTE:
      W = 0x80000000 | ((op & 7) << 28) | ((r.dstMod & 0xff) << 20) | ((r.dstSub & 0xf) << 16)
        | (G_OF(op) << 12) | ((r.srcMod & 0xff) << 4) | (r.srcSub & 0xf);
      return u(W);

    case FAMILY.BYTE_CONST:
      W = 0x80000000 | ((op & 7) << 28) | ((r.dstMod & 0xff) << 20) | ((r.dstSub & 0xf) << 16)
        | (G_OF(op) << 12) | (r.const8 & 0xff);
      return u(W);

    case FAMILY.ST: case FAMILY.LT: case FAMILY.LST: case FAMILY.LLT: {
      const isLoad = (fam === FAMILY.LST || fam === FAMILY.LLT);
      // File generation: LST/LLT share the ST/LT G values and set bit 11.
      const gBase = (fam === FAMILY.ST || fam === FAMILY.LST) ? 8 : 10;
      const slot = op - famBaseOf(fam);
      const G = gBase + (slot >= 8 ? 1 : 0);
      const t = r.time >>> 0;
      W = 0x80000000 | ((op & 7) << 28) | ((r.hi & 0xf) << 24)
        | ((t & 0xff) << 16) | (G << 12) | (isLoad ? 0x800 : 0);
      return u(W);
    }

    case FAMILY.DT:
      W = 0x80000000 | ((op & 7) << 28) | ((r.month & 0xf) << 24)
        | ((r.weekday & 7) << 21) | ((r.day & 0x1f) << 16) | (G_OF(op) << 12)
        | ((r.hour & 0x1f) << 6) | (r.minute & 0x3f);
      return u(W);

    default:
      throw new Error('unknown family ' + fam);
  }
}

// ---------------------------------------------------------------------------
// Text -> rule word. Mirrors the original pipeline: strip spaces, split off the
// comment, then match the canonical command text against the instruction table
// and fill the operand fields.
//
// Accepted operand notation (as emitted by renderFromDecoded and accepted by
// the original parser after DelSpaces):
//   MM.S.B op MM.S.B     bit  <-> bit          (MM, S, B hex)
//   MM.S.B op Bit-Konstante(0|1)
//   MM.S   op MM.S       byte <-> byte
//   MM.S   op $HH        byte <-> byte constant
//   ST|LST op ss.s   ·   LT|LLT op mmm
//   DT     op [WD, ]HH:MM        (WD = So..Sa, '*' allowed for HH/MM)
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const OPS = ['!=', '==', '>', '=<', '<', '>=', ':=', '~=', '&=', '|=', '^=', '+=', '-='];
// longest-first so '>=' is not mistaken for '>'
const OPS_BY_LEN = [...OPS].sort((a, b) => b.length - a.length);

function famBase(fam) {
  return { BYTE_BYTE: 8, BYTE_CONST: 24, ST: 40, LT: 56, DT: 72, LST: 88, LLT: 104 }[fam];
}
// opcode for a sparse family: compares at base+0..5, assignments at base+8..14
function opFor(fam, opIdx) {
  return famBase(fam) + (opIdx <= 5 ? opIdx : opIdx + 2);
}
const hexv = (s) => parseInt(s.replace(/^\$/, ''), 16);

export function compileLine(line) {
  let t = String(line);
  const c = t.indexOf('//');
  if (c >= 0) t = t.slice(0, c);
  t = t.replace(/;\s*$/, '').replace(/\s+/g, '');
  if (!t) return null;                      // blank / comment-only

  // find the operator (longest match, skipping a leading weekday/label)
  let opIdx = -1, at = -1;
  for (const o of OPS_BY_LEN) {
    const i = t.indexOf(o);
    if (i > 0 && (at < 0 || i < at)) { at = i; opIdx = OPS.indexOf(o); }
  }
  if (opIdx < 0) throw new Error(`kein Operator gefunden: ${line}`);
  const dst = t.slice(0, at);
  const src = t.slice(at + OPS[opIdx].length);

  // --- timer / datetime destinations -------------------------------------
  // timer destinations carry the timer number: ST<n>, LT<n>, LST<n>, LLT<n>
  const tm = dst.toUpperCase().match(/^(LST|LLT|ST|LT)(\d{1,2})?$/);
  if (tm) {
    const kwT = tm[1];
    const nr = tm[2] === undefined ? 0 : Number(tm[2]);
    if (nr < 0 || nr > 15) throw new Error(`Timernummer [0..15] erwartet: ${dst}`);
    if (kwT === 'ST' || kwT === 'LST') {
      const secs = parseFloat(src.replace(',', '.'));
      if (!Number.isFinite(secs) || secs < 0 || secs > 127.5) throw new Error(`Zeitwert [0..127.5] erwartet: ${src}`);
      return { opcode: opFor(kwT, opIdx), family: kwT, hi: nr, time: Math.round(secs * 2) };
    }
    const mins = parseInt(src, 10);
    if (!Number.isFinite(mins) || mins < 0 || mins > 255) throw new Error(`Zeitwert [0..255] erwartet: ${src}`);
    return { opcode: opFor(kwT, opIdx), family: kwT, hi: nr, time: mins };
  }
  const kw = dst.toUpperCase();
  if (kw === 'DT' || kw === 'DATETIME' || kw === 'DATE' || kw === 'TIME') {
    // WT, TT.MM SS:MM  — every part may be '*'
    const m = src.match(/^(?:(\*|[A-Za-z]{2}),)?(?:(\*|\d{1,2})\.(\*|\d{1,2}))?(\*|\d{1,2}):(\*|\d{1,2})$/);
    if (!m) throw new Error(`Zeitpunkt [WT,][TT.MM]SS:MM erwartet: ${src}`);
    const wdTok = m[1];
    let weekday = 7;                                   // 7 = wildcard
    if (wdTok && wdTok !== '*') {
      weekday = WEEKDAYS.findIndex((w) => w.toLowerCase() === wdTok.toLowerCase());
      if (weekday < 0) throw new Error(`Wochentag So..Sa erwartet: ${wdTok}`);
    }
    const day = !m[2] || m[2] === '*' ? 0 : Number(m[2]);
    const month = !m[3] || m[3] === '*' ? 0 : Number(m[3]);
    const hour = m[4] === '*' ? 24 : Number(m[4]);
    const minute = m[5] === '*' ? 60 : Number(m[5]);
    if (day > 31) throw new Error(`Tag [1..31] erwartet: ${day}`);
    if (month > 12) throw new Error(`Monat [1..12] erwartet: ${month}`);
    return { opcode: opFor('DT', opIdx), family: FAMILY.DT, weekday, day, month, hour, minute };
  }

  // --- module destinations -------------------------------------------------
  const dparts = dst.split('.');
  if (dparts.length === 3) {
    const [dm, ds, db] = dparts.map(hexv);
    const bc = src.match(/^Bit-Konstante\(([01])\)$/i);
    if (bc) {
      // opcodes 4..7: ==0 ==1 :=0 :=1
      const isAssign = OPS[opIdx] === ':=';
      if (!isAssign && OPS[opIdx] !== '==') throw new Error(`Bit-Konstante nur mit == oder := : ${line}`);
      return { opcode: 4 + (isAssign ? 2 : 0) + Number(bc[1]), family: FAMILY.BIT_CONST, dstMod: dm, dstSub: ds, dstBit: db };
    }
    const sp = src.split('.');
    if (sp.length !== 3) throw new Error(`MaS.SaS.BPS erwartet: ${src}`);
    const [sm, ss, sb] = sp.map(hexv);
    const bitOp = ['!=', '==', ':=', '~='].indexOf(OPS[opIdx]);
    if (bitOp < 0) throw new Error(`Bit-Operator !=,==,:=,~= erwartet: ${line}`);
    return { opcode: bitOp, family: FAMILY.BIT_BIT, dstMod: dm, dstSub: ds, dstBit: db, srcMod: sm, srcSub: ss, srcBit: sb };
  }
  if (dparts.length === 2) {
    const [dm, ds] = dparts.map(hexv);
    if (/^\$?[0-9A-Fa-f]{1,2}$/.test(src) && !src.includes('.')) {
      return { opcode: opFor('BYTE_CONST', opIdx), family: FAMILY.BYTE_CONST, dstMod: dm, dstSub: ds, const8: hexv(src) };
    }
    const sp = src.split('.');
    if (sp.length !== 2) throw new Error(`MaS.SaS oder Byte-Konstante erwartet: ${src}`);
    const [sm, ss] = sp.map(hexv);
    return { opcode: opFor('BYTE_BYTE', opIdx), family: FAMILY.BYTE_BYTE, dstMod: dm, dstSub: ds, srcMod: sm, srcSub: ss };
  }
  throw new Error(`Unbekannter Zieloperand: ${dst}`);
}

// Compile a whole source text to rule words (comments/blank lines skipped).
export function compileText(text) {
  const words = [], errors = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, n) => {
    try {
      const r = compileLine(line);
      if (r) words.push({ line: n + 1, word: encode(r), rule: r });
    } catch (e) {
      errors.push({ line: n + 1, text: line.trim(), error: e.message });
    }
  });
  return { words, errors };
}
