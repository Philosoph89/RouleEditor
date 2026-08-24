// Structured "automation" model on top of the byte-exact rule base.
//
// Verified against the real RouleBase.hrb (2026-08): every index entry (run) is
// exactly one CHAIN — an ordered list of statements "cond ; cond ; … ; action …"
// that executes until the first comparison fails. Many chains share one
// event-key (groupId). This mirrors the original parser source notation
//   EVENTKEY: cond; cond; action; action
// (e.g. 1A06: 00.0.6 == 1; 1A.0.0 ~= 1A.0.0).
//
// A chain is presented to the user as a WENN/DANN card:
//   Auslöser  = the event-key (module.sub.bit that changed, a timer, or time)
//   WENN      = the comparison statements (conditions)
//   DANN      = the assignment statements (actions)
//
// Round-trip is guaranteed: decode(word) -> renderFromDecoded -> compileLine ->
// encode == word for all 3704 stock rules, so editing via source lines is safe.

import { decode, encode, compileLine } from './compiler.js';
import { renderFromDecoded, OPERATORS } from './instructionset.js';

const ASSIGN = new Set([':=', '~=', '&=', '|=', '^=', '+=', '-=', ':=0', ':=1']);

const hx2 = (n) => (n & 0xff).toString(16).toUpperCase().padStart(2, '0');
const hx1 = (n) => (n & 0xf).toString(16).toUpperCase();

// event-key (groupId) -> {module, sub, bit, ev}
export function decodeTrigger(groupId) {
  const module = (groupId >> 7) & 0xff;
  const ev = groupId & 0x7f;
  const sub = (ev >> 3) & 0x0f;
  const bit = ev & 7;
  return { groupId, module, sub, bit, ev, token: `${hx2(module)}.${hx1(sub)}.${bit}` };
}

export function triggerGroupId(module, sub, bit) {
  return (((module & 0xff) << 7) | ((((sub & 0x0f) * 8) + (bit & 7)) & 0x7f)) & 0xffff;
}

// role of a statement from its decoded operator
function roleOf(d) {
  return ASSIGN.has(operatorText(d)) ? 'action' : 'condition';
}

function operatorText(d) {
  // BIT_CONST encodes op in G (==0/==1/:=0/:=1); others via OPERATORS index.
  // renderFromDecoded already knows; we re-derive the bare operator here.
  // opcode ranges: 0-3 bit ops (!= == := ~=), 4-7 bit-const (==0 ==1 := 0 :=1)
  const op = d.opcode;
  if (op <= 3) return ['!=', '==', ':=', '~='][op];
  if (op <= 7) return ['==0', '==1', ':=0', ':=1'][op - 4];
  // sparse families: operator index = position within the 16-slot group
  const within = (op - 8) % 16;
  const idx = within <= 5 ? within : within - 2; // skip the +6/+7 gap
  return OPERATORS[idx] || '?';
}

// Build the full editable model from a RuleBase.
export function buildModel(rulebase) {
  const runs = rulebase.commandRuns().map((run, i) => {
    const statements = run.rules.map((w) => {
      const word = w >>> 0;
      const d = decode(word);
      const source = renderFromDecoded(d);
      return {
        source,
        hex: '0x' + word.toString(16).toUpperCase().padStart(8, '0'),
        role: roleOf(d),
        family: d.family,
        operator: operatorText(d),
      };
    });
    return {
      i,
      groupId: run.entry.groupId,
      trigger: decodeTrigger(run.entry.groupId),
      count: run.rules.length,
      statements,
    };
  });
  return { runs, total: rulebase.commands.length };
}

// Apply an edited model back onto a RuleBase (rebuild index + commands).
// model.runs = [{ groupId, lines:[string] }] in order. Each line is parser
// syntax (dst op src). Returns { ok, errors:[{run,line,text,error}], counts }.
export function applyModel(rulebase, model) {
  const errors = [];
  const index = [];
  const commands = [];
  const runs = Array.isArray(model?.runs) ? model.runs : [];
  runs.forEach((run, ri) => {
    const groupId = Number(run.groupId) & 0xffff;
    const cmdOffset = commands.length;
    const lines = Array.isArray(run.lines) ? run.lines : [];
    let compiledAny = false;
    lines.forEach((line, li) => {
      const text = String(line || '').trim();
      if (!text) return;
      try {
        const r = compileLine(text);
        if (r) { commands.push(encode(r) >>> 0); compiledAny = true; }
      } catch (e) {
        errors.push({ run: ri, groupId, line: li, text, error: e.message });
      }
    });
    // keep the index entry even if empty (preserves an empty trigger slot)
    index.push({ groupId, cmdOffset });
    void compiledAny;
  });
  if (errors.length) return { ok: false, errors };
  rulebase.index = index;
  rulebase.commands = commands;
  return { ok: true, errors: [], counts: { runs: index.length, words: commands.length } };
}
