// Reader/writer for the RouleEditor `RouleBase.hrb` rule-base file.
//
// Format (reverse-engineered from RouleEditorV2103.exe, verified byte-exact):
//
//   file  = uint32[]  (little endian)
//         = indexRegion  terminator  commandRegion  balancer
//
//   indexEntry = (groupId << 17) | (cmdOffset & 0x1FFFF)
//   terminator = an entry whose value >= 0xFFFE0000; low 17 bits = rule count
//   command    = 32-bit packed rule word
//   balancer   = one trailing word chosen so XOR(all words) === 0x15
//
// See ../../port/rulebase.py and ../../re/docs/hrb_format.md.

export const CHECKSUM_CONST = 0x15;
export const TERMINATOR_MIN = 0xfffe0000;
export const OFFSET_MASK = 0x1ffff; // low 17 bits
export const GROUP_SHIFT = 17;

export class RuleBase {
  constructor() {
    this.index = [];          // [{ groupId, cmdOffset }]
    this.commands = [];       // rule words (declared count)
    this.balancer = 0;
    this.hasBalancer = false;
    this.storedChecksum = 0;
    this.checksumOk = false;
    this.terminatorRaw = 0;
    this.declaredCmdCount = 0;
  }

  // ---- parsing -------------------------------------------------------------
  static fromBuffer(buf) {
    if (buf.length % 4 !== 0) throw new Error('hrb size is not a multiple of 4');
    const words = new Array(buf.length / 4);
    for (let i = 0; i < words.length; i++) words[i] = buf.readUInt32LE(i * 4);

    const rb = new RuleBase();
    let xor = 0;
    for (const w of words) xor = (xor ^ w) >>> 0;
    rb.storedChecksum = xor;
    rb.checksumOk = xor === CHECKSUM_CONST;

    let i = 0;
    let termCount = null;
    for (; i < words.length; i++) {
      const w = words[i] >>> 0;
      if (w >= TERMINATOR_MIN) {
        termCount = w & OFFSET_MASK;
        rb.terminatorRaw = w;
        rb.declaredCmdCount = termCount;
        i++;
        break;
      }
      rb.index.push({ groupId: w >>> GROUP_SHIFT, cmdOffset: w & OFFSET_MASK });
    }
    if (termCount === null) throw new Error('no index terminator found');

    const rest = words.slice(i);
    // rule region = declared count rule words + 1 XOR balancer word
    if (rest.length === termCount + 1) {
      rb.commands = rest.slice(0, termCount);
      rb.balancer = rest[termCount] >>> 0;
      rb.hasBalancer = true;
    } else {
      rb.commands = rest;
      rb.hasBalancer = false;
    }
    return rb;
  }

  // ---- serialisation -------------------------------------------------------
  // rebuild=false  -> preserve original terminator + balancer (byte-exact)
  // rebuild=true   -> regenerate rule count and rebalance XOR to 0x15
  toWords(rebuild = false) {
    const out = this.index.map(
      (e) => (((e.groupId << GROUP_SHIFT) | (e.cmdOffset & OFFSET_MASK)) >>> 0)
    );
    const termIdx = out.length;
    out.push(rebuild ? (TERMINATOR_MIN | (this.commands.length & OFFSET_MASK)) >>> 0
                     : this.terminatorRaw >>> 0);
    for (const c of this.commands) out.push(c >>> 0);

    if (rebuild) {
      let acc = 0;
      for (const w of out) acc = (acc ^ w) >>> 0;
      out.push((acc ^ CHECKSUM_CONST) >>> 0);
    } else if (this.hasBalancer) {
      out.push(this.balancer >>> 0);
    }
    return out;
  }

  toBuffer(rebuild = false) {
    const words = this.toWords(rebuild);
    const buf = Buffer.allocUnsafe(words.length * 4);
    for (let i = 0; i < words.length; i++) buf.writeUInt32LE(words[i] >>> 0, i * 4);
    return buf;
  }

  // ---- rule grouping -------------------------------------------------------
  // Yields { entry, rules } where rules are the words for each index entry,
  // bounded by consecutive command offsets.
  commandRuns() {
    const bounds = this.index.map((e) => e.cmdOffset).concat([this.commands.length]);
    const runs = [];
    for (let k = 0; k < this.index.length; k++) {
      const start = bounds[k];
      const end = bounds[k + 1];
      if (start >= 0 && start <= end && end <= this.commands.length) {
        runs.push({ entry: this.index[k], start, end, rules: this.commands.slice(start, end) });
      } else {
        runs.push({ entry: this.index[k], start, end, rules: [] });
      }
    }
    return runs;
  }

  summary() {
    return {
      indexEntries: this.index.length,
      commandWords: this.commands.length,
      declaredCmdCount: this.declaredCmdCount,
      hasBalancer: this.hasBalancer,
      storedChecksum: '0x' + this.storedChecksum.toString(16).toUpperCase().padStart(2, '0'),
      checksumOk: this.checksumOk,
    };
  }
}
