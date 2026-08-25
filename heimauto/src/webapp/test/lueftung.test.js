// Die Lüftung gegen das ORIGINAL-LOG geprüft.
//
// Quelle: "Lüftung oben 15x hoch und 15x runter geschaltet" (2026-08-25), vom
// Original-Programm an der laufenden Anlage mitgeschrieben. Das Log enthält die
// echten Bus-Bytes: den Taster (Modul 0x31, Bit 1 = höher, Bit 0 = niedriger),
// das Stufenregister 1C.0 (00,11,22,…,EE) und die Stufen-LEDs auf Sub 1 von
// acht Modulen. Genau diese Werte muss die Bridge reproduzieren.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RuleBase } from '../src/hrb.js';
import { deriveEntities, mergeOverrides } from '../src/entities.js';
import { Bridge } from '../src/bridge.js';
import { MODULE_TYPES, LABEL_SEED } from '../src/moduleinfo.js';

const rb = RuleBase.fromBuffer(readFileSync(new URL('../../RouleBase.hrb', import.meta.url)));
const labels = { ...LABEL_SEED };
const entities = mergeOverrides(deriveEntities(rb, { labels }), {}, { labels });
const fan = entities.find((e) => e.id === 'level_1c_0');

// --- Log einlesen: Stufe -> erwartete Ausgangsbytes ---
const log = readFileSync(new URL('./fixtures/lueftung-oben.log', import.meta.url), 'utf8').split('\n');
function expectedFromLog() {
  // Jeder Block endet mit dem 1C.0-Schreibvorgang der erreichten Stufe; die
  // Tx-Zeilen davor sind die LEDs derselben Aktion.
  const blocks = [];
  let cur = [];
  for (const line of log) {
    const tx = line.match(/^Tx-Data: \(([0-9A-F]{2})\.([0-9A-F])\) <- ([0-9A-F]+)/);
    if (tx) { cur.push({ mod: parseInt(tx[1], 16), sub: parseInt(tx[2], 16), val: parseInt(tx[3], 16) }); continue; }
    if (/Rx-Data/.test(line)) { if (cur.length) blocks.push(cur); cur = []; }
  }
  if (cur.length) blocks.push(cur);
  const out = [];
  for (const b of blocks) {
    const level = b.find((x) => x.mod === 0x1c && x.sub === 0);
    if (!level) continue;
    out.push({ level: level.val, leds: b.filter((x) => x.sub === 1) });
  }
  return out;
}
const steps = expectedFromLog();

test('das Log enthält die 28 Stufenwechsel (14 hoch, 14 runter)', () => {
  assert.equal(steps.length, 28);
  assert.deepEqual(steps.slice(0, 14).map((s) => s.level),
    [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
  assert.equal(steps.at(-1).level, 0x00);
});

test('die Lüftung wird als 16-stufiger fan abgeleitet', () => {
  assert.ok(fan, '1C.0 muss eine Entität sein');
  assert.equal(fan.kind, 'fan', 'der Name „Lüftung" macht daraus einen fan');
  assert.equal(fan.step, 0x11);
  assert.equal(fan.min, 0x00);
  assert.equal(fan.max, 0xff);
  assert.equal(fan.steps, 16, '0x00…0xFF in Schritten von 0x11 = 16 Stufen');
  assert.equal(MODULE_TYPES['1C'].type, 'Analog', 'das Register sitzt auf dem Analog-Modul');
});

test('jede Stufe erzeugt genau den Registerwert des Originals', () => {
  const sent = [];
  const b = new Bridge({ queueOutput: (M, sub, val) => sent.push({ M, sub, val }) });
  b.setEntities([fan]);
  for (let i = 0; i < 16; i++) {
    sent.length = 0;
    b.command(fan.id, { level: i });
    const reg = sent.find((s) => s.M === 0x1c && s.sub === 0);
    assert.equal(reg.val, i * 0x11, `Stufe ${i} -> 0x${(i * 0x11).toString(16)}`);
  }
});

test('die Stufen-LEDs stimmen beim Hochfahren byte-genau mit dem Log überein', () => {
  const b = new Bridge({ queueOutput: () => {} });
  b.setEntities([fan]);
  let checked = 0;
  for (const s of steps.slice(0, 14)) {          // 0x11 … 0xEE, Taster 0x1881
    b.command(fan.id, { level: Math.round(s.level / 0x11) });
    for (const led of s.leds) {
      assert.equal(b.getByte(led.mod, led.sub), led.val,
        `Stufe 0x${s.level.toString(16)}: ${led.mod.toString(16)}.${led.sub} muss 0x${led.val.toString(16)} sein`);
      checked++;
    }
  }
  assert.ok(checked >= 100, `genug LED-Bytes geprüft (waren ${checked})`);
});

test('beim Runterfahren zeigt das Original einen Fehler in EINEM Taster', () => {
  // Die 16 LED-Ketten stehen viermal in der Regelbasis, einmal je Bedien-Taster.
  // Drei sind identisch, der Taster 0x1880 („Flur OG niedriger") schreibt bei
  // Stufe 0x22 und 0x00 ein falsches Muster: 31.1 = 0x70 statt 0xF0 bzw. 0x30.
  // Im Log ist das zu sehen — beim Runterfahren bleibt die Anzeige stehen.
  const down = steps.slice(14);
  const at = (lvl) => down.find((s) => s.level === lvl)?.leds.find((l) => l.mod === 0x31 && l.sub === 1)?.val;
  assert.equal(at(0x22), 0x70, 'Log: falsches Muster bei Stufe 0x22');
  assert.equal(at(0x00), 0x70, 'Log: falsches Muster bei Stufe 0x00');
  assert.equal(at(0x33), 0x01, 'die übrigen Stufen sind auch abwärts korrekt');

  // Die Ableitung meldet genau diese zwei Abweichungen …
  assert.equal(fan.indicatorConflicts.length, 2);
  assert.deepEqual(fan.indicatorConflicts.map((c) => c.value).sort((a, b) => a - b), [0x00, 0x22]);
  for (const c of fan.indicatorConflicts) {
    assert.deepEqual(c.deviating, ['0x1880']);
    assert.equal(c.majority.length, 3);
  }
  // … und die Bridge nimmt die Mehrheitsvariante, ist also korrekter als das Original.
  const b = new Bridge({ queueOutput: () => {} });
  b.setEntities([fan]);
  b.command(fan.id, { level: 2 });
  assert.equal(b.getByte(0x31, 1), 0xf0, 'Stufe 2 zeigt das richtige Muster');
  b.command(fan.id, { level: 0 });
  assert.equal(b.getByte(0x31, 1), 0x30);
});

test('alle übrigen Runter-Stufen stimmen ebenfalls mit dem Log überein', () => {
  const b = new Bridge({ queueOutput: () => {} });
  b.setEntities([fan]);
  let checked = 0;
  for (const s of steps.slice(14)) {
    b.command(fan.id, { level: Math.round(s.level / 0x11) });
    for (const led of s.leds) {
      if ((s.level === 0x22 || s.level === 0x00) && led.mod === 0x31) continue;  // Original-Fehler
      assert.equal(b.getByte(led.mod, led.sub), led.val,
        `Stufe 0x${s.level.toString(16)}: ${led.mod.toString(16)}.${led.sub}`);
      checked++;
    }
  }
  assert.ok(checked >= 100, `genug LED-Bytes geprüft (waren ${checked})`);
});

test('hoch/runter zählt stufenweise und bleibt an den Grenzen stehen', () => {
  const b = new Bridge({ queueOutput: () => {} });
  b.setEntities([fan]);
  b.command(fan.id, { level: 0 });
  for (let i = 0; i < 20; i++) b.command(fan.id, 'UP');
  assert.equal(b.levelState(fan).level, 15, 'oben ist Schluss (kein Überlauf)');
  assert.equal(b.getByte(0x1c, 0), 0xff);
  for (let i = 0; i < 20; i++) b.command(fan.id, 'DOWN');
  assert.equal(b.levelState(fan).level, 0);
  assert.equal(b.getByte(0x1c, 0), 0x00);
});

test('Prozent von Home Assistant wird auf Stufen gerastet', () => {
  const b = new Bridge({ queueOutput: () => {} });
  b.setEntities([fan]);
  b.command(fan.id, { percentage: 100 });
  assert.equal(b.getByte(0x1c, 0), 0xff);
  b.command(fan.id, { percentage: 0 });
  assert.equal(b.getByte(0x1c, 0), 0x00);
  b.command(fan.id, { percentage: 50 });
  assert.equal(b.levelState(fan).level, 8, '50 % von 15 Stufen = Stufe 8 (gerundet)');
});

test('AUS und EIN merken die letzte Stufe nicht auf, sondern gehen auf 0 / Maximum', () => {
  const b = new Bridge({ queueOutput: () => {} });
  b.setEntities([fan]);
  b.command(fan.id, { level: 5 });
  b.command(fan.id, 'OFF');
  assert.equal(b.levelState(fan).state, 'OFF');
  assert.equal(b.getByte(0x1c, 0), 0x00);
  b.command(fan.id, 'ON');
  assert.equal(b.levelState(fan).level, 15);
});

test('der Betriebsart-Wähler 1C.7 hat 8 Stellungen mit Rundlauf', () => {
  // Regeln: "1C.7 > $07 ; 1C.7 := $00" (Überlauf) und "1C.7 += $01"
  const sel = entities.find((e) => e.id === 'level_1c_7');
  assert.ok(sel, '1C.7 muss erkannt werden');
  assert.equal(sel.steps, 8);
  assert.equal(sel.wrap, true);
  assert.equal(sel.kind, 'level', 'kein fan — der Name sagt nichts über Lüftung');
  const b = new Bridge({ queueOutput: () => {} });
  b.setEntities([sel]);
  b.command(sel.id, { level: 7 });
  b.command(sel.id, { step: 1 });
  assert.equal(b.levelState(sel).level, 0, 'nach der letzten Stellung kommt wieder die erste');
});

test('die Stufe überlebt einen Neustart', () => {
  const b = new Bridge({ queueOutput: () => {} });
  b.setEntities([fan]);
  b.command(fan.id, { level: 9 });
  const snap = JSON.parse(JSON.stringify(b.snapshot()));
  const fresh = new Bridge({ queueOutput: () => {} });
  fresh.restore(snap);
  fresh.setEntities([fan]);
  assert.equal(fresh.levelState(fan).level, 9);
  assert.equal(fresh.getByte(0x1c, 0), 9 * 0x11);
});

// --- Gegenprobe über den Interpreter (Betriebsart „Original") ---------------
// Nicht die Bridge, sondern die Regelbasis selbst: dieselbe Tastenfolge wie im
// Log durch processEventKey schicken und JEDES Ausgangsbyte vergleichen. Das
// deckte auf, dass nicht registrierte Module originalgetreu auf Slot 0 zeigen
// und sich dadurch den Speicher teilten — alle acht LED-Module meldeten 0xF5.
test('der Interpreter erzeugt die Bytefolge des Originals', async () => {
  const { Interpreter } = await import('../src/interpreter.js');
  const { LiveController } = await import('../src/livecontrol.js');
  const it = new Interpreter(rb);
  const live = new LiveController(it);
  live.setModules([0x10, 0x11, 0x13, 0x15, 0x18, 0x19, 0x1b, 0x1c, 0x31]);

  const KEY_UP = (0x31 << 7) | 1;          // 31.0.1 „höher"
  const S = it.state;
  S.setSubByte(0x31, 7, 0x01);              // Merker 31.7.0 gesetzt (wie im Log)

  function press(value) {
    // Eingangswerte gehen über noteReported (die gemeldeten Werte), nicht in den
    // Modul-Record: nur die speist die relative Adressierung 00.x.y.
    it.noteReported(0x31, 0, value);
    it.mirrorContext(0x31);
    const finals = new Map();
    for (const f of it.processEventKey(KEY_UP)) {
      for (const c of f.changes) finals.set((c.module << 4) | c.sub, { module: c.module, sub: c.sub });
    }
    return [...finals.values()]
      .filter((o) => o.module !== 0x00)
      .map((o) => ({ mod: o.module, sub: o.sub, val: S.getSubByte(o.module, o.sub) }));
  }

  let compared = 0;
  for (const expected of steps.slice(0, 14)) {          // die 14 Stufen aufwärts
    // Im Log fällt der Registerwechsel auf das DRÜCKEN; das Loslassen schreibt
    // nur noch die LEDs derselben Stufe nach.
    const out = press(0x02);
    press(0x00);
    const reg = out.find((o) => o.mod === 0x1c && o.sub === 0);
    assert.ok(reg, `Stufe 0x${expected.level.toString(16)}: Register muss geschrieben werden`);
    assert.equal(reg.val, expected.level, `Registerwert Stufe 0x${expected.level.toString(16)}`);
    for (const led of expected.leds) {
      const own = out.find((o) => o.mod === led.mod && o.sub === led.sub);
      assert.ok(own, `${led.mod.toString(16)}.${led.sub} muss geschrieben werden`);
      assert.equal(own.val, led.val,
        `Stufe 0x${expected.level.toString(16)}: ${led.mod.toString(16)}.${led.sub} = 0x${led.val.toString(16)}`);
      compared++;
    }
  }
  assert.ok(compared >= 100, `genug Bytes gegen das Log geprüft (waren ${compared})`);
});
