# Status: originalgetreuer Nachbau

Ziel: RouleEditor Web verhält sich **komplett wie das Original** (Lizenzprüfung
entfällt bewusst). Fortschritt in 3 Stufen (Editor → Simulator → Protokoll).
Grundlage ist das Reverse-Engineering der Schlüsselfunktionen auf
Assembler-Ebene (`re/ghidra/asm_rbexec.txt`, `re/ghidra/asm_dump.txt`).

Legende: ✅ verifiziert-exakt · 🟡 hohe Konfidenz · 🔧 in Arbeit · ⬜ offen

## Stufe 1 — Editor

| Baustein | Status | Quelle / Nachweis |
|----------|--------|-------------------|
| `.hrb` laden/speichern/import/export | ✅ | byte-exakt, `test/hrb.test.js` |
| Prüfsumme (XOR==0x15) + Balancer + Rebuild | ✅ | verifiziert |
| **Bitfeld-Decode jedes Regelworts** | ✅ | 1:1 aus RBExecCmd-Prolog (`src/ruleword.js`) |
| Modul-Adressierung `dst = base + hi‑nibble`, sub, bit | ✅ | asm `[-0x1c]`, `[-0x22]`, `[-0xc]` |
| Quell-Adressierung (Ma.Sa.Bit / Konstante k über Bit 11) | ✅ | asm + Verteilungscheck |
| Bit-Operationen 0..7 (`!=,==,:=,~=`, `==0/==1/:=0/:=1`) | ✅ | RBExecCmd bit31==0 Selektor + G0‑3 |
| Vergleiche (`!=,==,>,=<,<,>=`) für Byte/ST/LT/DT | ✅ | Komparatoren `FUN_0046AFC0`/`FUN_0046B050` (identisch), Operator = `(W>>28)&7` |
| Opcode-Zuordnung G4‑G12 → Editor-Index 8‑13/24‑29/40+/56+/72+ | ✅ | 3701/3704 Regeln exakt, 3 Randfälle (Operator 6/7 = ungenutzt) |
| Byte-Exakter bidirektionaler Codec (7 kanonische Felder) | ✅ | `canonicalFields`/`packCanonical`, Round-Trip-Test über alle 3704 |
| Editieren über Rohwort + kanonische Felder | ✅ | byte-exakt, im Editor verdrahtet |

**Editor-Ergebnis:** Jede Regel wird mit ihrer echten Operation
(z. B. `Ma.Sa.Bit := 0`, `Ma.Sa > k`, `DT == Date+Time`), dem Editor-Opcode-Index
und der `dst ← src`-Adressierung (M`addr`.`sub`.`bit`) angezeigt. Bearbeitung über
7 überlappungsfreie kanonische Felder ist byte-exakt (Round-Trip verifiziert).
Von 3704 Regeln erhalten 3701 einen exakten Opcode-Namen; 3 nutzen einen im
Original ungenutzten Komparator-Operator (6/7) und werden als `?6/?7` markiert.

**Stufe 1 gilt damit als abgeschlossen.** Offen bleibt bewusst nur der
zusätzliche Komfort-Encoder „Opcode-Dropdown → Wort" (Stufe 2/Editor-Komfort),
da Regeln bereits über die kanonischen Felder byte-genau erzeugt/bearbeitet werden.

## Stufe 2 — Simulator (Interpreter RBExecCmd)  ✅ Kern fertig

Umgesetzt in `src/interpreter.js`, in den Simulator verdrahtet, per `node:test`
gegen die echte Regelbasis + gezielte Logik-Fälle validiert (10/10 Tests grün).

| Baustein | Status | Nachweis |
|----------|--------|----------|
| Feld-Extraktion (Prolog) | ✅ | 1:1 aus asm |
| Zustandsmodell: 48 Module × 80‑Byte‑Record | ✅ | `S[slot*80 + off]`, Sub‑Byte `off(s)=s<8?0x10+s:0x18+s` |
| Modul-Map `addr→slot` (`0x483f00`) | ✅ | Null‑Init‑Aliasing auf Slot 0 wie im Original, Registrierung on demand |
| Bitmasken `0x474e4c`, Änderungsmasken `0x474e5c` | ✅ | aus Binär gelesen |
| Bit-Operationen (==0/==1/:=0/:=1, 2‑Operand !=,==,:=,~=) | ✅ | alle switch‑Fälle transkribiert; 2849/3704 Regeln exakt |
| Vergleiche Byte/ST/LT/DT (`!=,==,>,=<,<,>=`) | ✅ | Komparator 1:1; Operand = Sub‑Byte bzw. Konstante/Timer |
| Ausgabe `AddChgMsg` (Änderungs‑Flag +0x28) | ✅ | Flag gesetzt + Change‑Event für Propagation |
| Ausführungs‑Harness `ExecMsgList` (Bedingungskette) | ✅ | Regel = Wortfolge, `false` stoppt den Run |
| Änderungs‑Propagation (Injection → Folge‑Regeln) | ✅ | Queue bis Ruhe, im Simulator nutzbar |

**Verbleibende Feinheiten (kein Kern-Fehler, dokumentiert):**
- Der exakte Operanden‑Fetch der Byte‑Vergleiche im Original (`FUN_00460300`,
  Wert‑Tabellen‑Akkumulation) ist vereinfacht auf „Sub‑Byte-Wert vergleichen".
  Für boolesche Bit‑Automation (77 % der Regeln) ist die Ausführung exakt.
- ST/LT/DT‑Zeitbasis (Timer‑Dekrement, Datums‑Vergleichsfelder) ist als Modell
  vorhanden; das genaue Tick‑/Wildcard‑Verhalten wird in Stufe 3 (Poll‑Timer)
  finalisiert.

## Stufe 3 — HomeBus-Protokoll  ✅ Empfang + Poll + Ausgang live an echter Anlage

Umgesetzt in `src/homebus.js` (Deframer, Zeitbasis, Timer-Tabellen),
verdrahtet in Server/Monitor/Simulator, 18/18 Tests grün.

| Baustein | Status | Nachweis |
|----------|--------|----------|
| RX-Puffer (0x48400C), Limit, High-Water, Overflow-Restart | ✅ | asm 0x00470674 1:1 |
| **Frame-Sync `buf[1] == (~buf[0] & 0xFF)`** | ✅ | asm 0x00470912‑0x0047091F |
| Mindestlänge 4 Byte, Resync durch 1‑Byte‑Verwerfen | ✅ | asm 0x0047090C / 0x00470760 |
| Scan in **2‑Byte‑Paaren** ab Offset 2 (`p += 2`, `p < count‑1`) | ✅ | asm 0x00470E14‑0x00470E36 |
| Kommandoklassen nach `(b & 0x1F)`: 0‑14,31→A · 15→B · 16‑30→C | ✅ | asm 0x00470966‑0x0047097B |
| XOR‑Prüfsumme über `&0x7F` + Flag‑Konsistenz (0x40/0x20) | ✅ | asm 0x00470991‑0x00470A41 |
| **Zeitbasis**: Minutenwechsel → Event‑Key **8** | ✅ | `SystemTimer` 0x00467F10; passt zu `groupId=8` in der echten Regelbasis |
| ShortTimer jeden 2. Tick, LongTimer alle 240 Ticks (Reload 0xF0) | ✅ | `SystemTimer` |
| Timer sind **id‑adressiert** (max. 31 Einträge je Typ) | ✅ | `FUN_00460300`; id = `(EventKey & 0x7FF0) \| ((W>>24)&0xF)` |
| Timer‑Preset `((W>>16)&0xFF + (W&0x1FF)) * 5` | ✅ | asm 0x00469370‑0x00469397 |
| Payload‑Semantik der Klassen B (15) und C (16‑30) | ⬜ | benötigt Hardware oder `rx-Log.txt` |
| Endgültige Framelänge/Terminierung | ⬜ | dito |
| **Modul‑Polling / TX‑Rahmen** (`PollNextAnnMod` 0x00467364) | ✅ | Poll‑Frame `[~M, M, S, S]`, `S=(oddParity(base)<<7)|base`, `base=(M&0x40)\|0x0F`; Paritätsbit = `FUN_00467324` |
| **Ausgangs‑Rahmen** (`buildOutput`, Master‑Burst `sub_00467e00` Branch B) | ✅ | `[~M, M, ctrl, val, cs]`; `base=(M&0x40)\|(val&0x20)\|col` (+0x10 falls weitere Spalten/col=0xF); `ctrl=base\|((base^val)&0x80)`; `cs=((base^val)&0x7f)\|(val&0x80)` |
| **Ausgang verifiziert — live + Original‑Log** | ✅ | live: `E5 1A 00 01 01` schaltet HWR‑Relais (Blinken); Log: `(10.F)<-10` == `EF 10 1F 10 0F` byte‑genau (`re/captures/Hochlauf_2026-08-18_original-evlog.txt`) |
| **Live‑Automat** (Eingang→Regel→echter Ausgang) | ✅ | `src/livecontrol.js` `LiveController` → `onOutput` → `Poller.pulseOutput`; HWR‑Schalter→Licht end‑to‑end live verifiziert |
| **Burst‑Polling wie das Original** (alle Module in EINEM Write pro Zyklus) | ✅ | Original‑Log: alle 25 Segmente teilen einen Zeitstempel, Zyklus ~110 ms, je Modul `[~M,M,ctrl,val]` + 3× Padding `FF 00 0F 0F`. Round‑Robin (25×50 ms = 1,25 s/Modul) war die Ursache der ~3 s Reaktionszeit — jetzt **30–89 ms** von Erkennung bis Senden (live gemessen) |
| **Ausgangs‑Puls poll‑zählend** (nicht zeitbasiert) | ✅ | Round‑Robin: ein Modul ist erst nach `Anzahl×Intervall` (25×50 ms = **1250 ms**) wieder dran; Wanduhr‑Fenster läuft vorher ab → Frame ging nie raus. `_consumePulse`, Tests in `test/pulse.test.js` |
| **Validierung gegen echte Anlage** (`/dev/cu.usbserial-110`, **115200 Baud**) | ✅ | 19–25 Module live erkannt (0x10‑1C, 0x20‑24, 0x30‑31, 0x40‑44), Live‑Daten fließen, Ausgang schaltet physisch |
| macOS `cu.`‑Port statt `tty.` | ✅ | serialManager mappt automatisch |

**Was die App jetzt kann:** Empfangene Bytes werden synchronisiert, in Frames
zerlegt und im Monitor mit Klassenfolge, Prüfsummenstatus und Flag‑Fehlern
angezeigt (statt nur Roh‑Hex). Die Zeitbasis läuft (1 Tick/s, start/stop/einzeln)
und führt bei Minutenwechsel den Event‑Key 8 gegen die echte Regelbasis aus;
ST/LT‑Timer laufen mit der originalen Kadenz.

**Diagnose des „Monitor bleibt leer"-Problems (gelöst):** Der HomeBus ist ein
**gepollter Master/Slave‑Bus** — die Anlage sendet nichts von allein, sie
antwortet nur auf Polls. Live‑Test an `/dev/cu.usbserial-110`: 0 Bytes bei allen
Baudraten, keine Steuersignale — bis der Poll gesendet wurde. Dann antworten
25 Module. Der Poller (`src/homebus.js` → `Poller`, `buildPoll`) sendet die Polls
round‑robin; UI‑Knöpfe **„Module suchen"** + **„Polling starten"** im Monitor.

**Ausgang gelöst:** Der Ausgangs‑Rahmen wurde aus dem Master‑Sende‑Burst
(`sub_00467e00`, Branch B) vollständig reverse‑engineert und **doppelt
verifiziert** — physisch an der Anlage (HWR‑Relais blinkt) und byte‑genau gegen
das Original‑Event‑Log. Der Live‑Automat verdrahtet damit die komplette Kette
**Poll‑Antwort → Eingangsänderung → Event‑Key → Regel → echtes Ausgangs‑Frame**.
Zwei frühere Fehler (immer gesetztes 0x10‑Flag, fehlendes/falsches XOR‑Prüfbyte)
sind behoben; ein korrektes Frame wird vom Modul beantwortet, ein falsches nicht.

**Zeitgesteuerte Regeln (offen, bewusst deaktiviert):** Die Regelbasis hat 140
Regeln am Zeit‑Auslöser (Event‑Key 8) plus Timer‑Ablaufevents (`LST/LT`). Die
Zeitbasis läuft im Live‑Betrieb **standardmäßig nicht**; erst der Schalter
„Zeitschaltuhr mitlaufen lassen" (Monitor) startet sie, weil die Anlage dann
selbständig schaltet (Rolladen, Außenlicht). Die Zustellung ist verdrahtet
(`deliverChanges`), und der Zeit‑Event nutzt jetzt `processEventKey` statt
`processModule` (korrekte Basis für relative Adressen). **Ungeprüft:** die
Zuordnung ablaufender Timer → Event‑Key (`onTimerExpired` → `processModule((id>>4)&0xff)`)
ist noch nicht gegen das Original verifiziert — betrifft z. B. das automatische
Stoppen der Rolladen nach `LST9 := 30 s`.

**Timer‑Nummern: Stoppuhr vs. Ablaufevent (verifiziert an der Regelbasis).**
Die Timer‑ID ist `(EventKey & 0x7FF0) | Nr`; als Event‑Key gelesen wird die
Nummer zu `sub*8+bit`. Nummern **8‑15** landen auf **sub 1** — dort liegen die
36 „Ablaufevents" (Auto‑Stopp). Nummern **0‑7** landen auf **sub 0**, wo die
**physischen Taster** liegen (23 Kollisionen). Niedrige Nummern sind reine
Stoppuhren (nur über Vergleiche wie `LST0 > 0.0` gelesen) und dürfen **kein**
Event feuern. Vorher feuerte jeder Timer: `LST0` der Küchenlampe hat ID `0x900`
= Jalousie‑Auf‑Taster von Modul 0x12 → Licht ausschalten stoppte die Jalousie.

**Noch offen (Feinheiten):** mehrere Ausgangs‑Spalten eines Moduls in **ein**
Segment bündeln (aktuell ein Frame je Spalte — beides gültig, Modul akzeptiert
beides); der `col‑0xF`‑Announce‑Handshake (`state[slot+0x2d]` 0x80→0x81→0x82)
aus dem Hochlauf‑Log; Payload‑Semantik der Klassen B (15)/C (16‑30) in Antworten.

## Nächste Schritte (Reihenfolge)
1. G4–G7-Byte-Zuweisungen + ST/LT/DT-Operatoren final aus RBExecCmd transkribieren → Editor-Operationen zu 100 % ✅.
2. Encoder aus den `Set*`-Buildern → Editieren über Opcode-Dropdown byte-genau.
3. Interpreter-Ausführung (alle Fälle) + Modul-Registrierung + `AddChgMsg` → Simulator originalgetreu.
4. RX/Poll/TX portieren → Protokoll; final gegen echte Module verifizieren.

Alle RE-Artefakte (Assembler-Dumps, Sprungtabellen, Zustandsmodell) liegen unter
`re/ghidra/` und sind so fortführbar.

---

## Nachtrag: ParserV1000.exe reversed → autoritativer Befehlssatz ✅

`ParserV1000.exe` ist der Original-Compiler **Text → RouleBase.hrb**
(„Code Parser V1.000 Roulebase Version 2.1"). Er liefert die definitive
Spezifikation, die aus dem Editor allein nicht rekonstruierbar war.

| Erkenntnis | Status |
|------------|--------|
| **99 Befehle in 9 Familien** (Tabelle bei 0x004474FC..0x004480FC) | ✅ 1:1 übernommen, Literale per Test verifiziert |
| **13 Operatoren** `!= == > =< < >= := ~= &= \|= ^= += -=` | ✅ erste 6 = die 6 Fälle der Komparator-Helfer → unabhängige Bestätigung |
| Familien **LST** / **LLT** (im Editor-Dropdown gar nicht vorhanden) | ✅ neu entdeckt |
| Warum das Editor-Dropdown 83 Einträge mit Lücken hat | ✅ geklärt: 8er-Gruppen-Auffüllung derselben Liste |
| Vollständige Operanden-Syntax + Wertebereiche | ✅ aus `GetDstObjectType`/`GetSrcObjectType` + Fehlermeldungen |
| ST/LST = `ss.s` (0,5-s-Schritte, ×5) · LT/LLT = `mmm` | ✅ bestätigt das Preset `*5` aus Stufe 3 |
| Regelbasis als **Original-Quelltext** darstellbar | ✅ `GET /api/rulebase/source`, Spalte „Quelltext" im Editor |

**Semantische Gegenprobe (starkes Validierungsargument):** Die echte
`RouleBase.hrb` rendert zu sinnvoller Hausautomatisierungs-Logik —
`DT==05:00; 10.7.5==Bit-Konstante(1); 10.7.0:=Bit-Konstante(0); …` —
also Zeitbedingung + Freigabebit + Aktionen. Das bestätigt Feldlayout,
Opcode-Zuordnung *und* das Bedingungsketten-Modell zugleich.

Spezifikation: [`../re/docs/rule_syntax.md`](../re/docs/rule_syntax.md)

### Was daraus noch folgen kann
- **Text→Binär-Compiler** (Gegenstück zum Renderer): braucht die exakte
  Bit-Zuordnung je Opcode aus `TCheckRoules.ParseLine`. Das Feldlayout ist
  bekannt; zu klären bleibt die Kodierung der Zuweisungs-Operatoren (Index 6..12
  passen nicht in die 3 Bit von `(W>>28)&7`).

---

## Text→Binär-Compiler ✅ (aus ParserV1000.exe transkribiert)

Der Bit-Assembler des Originals (`FUN_00443770`, gerufen aus `FUN_00448114`)
wurde instruktionsweise nach `src/compiler.js` übertragen.

**Die vollständige Opcode-Formel (verifiziert):**
```
bit31 = 0        -> BIT_BIT     opcode = bit15*2 + bit11        (0..3)
bit31 = 1, G < 4 -> BIT_CONST   opcode = G + 4                  (4..7)
bit31 = 1, G >= 4-> Wertfamilie opcode = (G-3)*8 + ((W>>28)&7)
                    G4/5=BYTE_BYTE G6/7=BYTE_CONST G8/9=ST
                    G10/11=LT     G12/13=DT
```
Die echte Opcode-Nummerierung hat **119 Slots** mit 20 Lücken
(14,15,23,30,31,39,46,47,55,62,63,71,78,79,87,94,95,103,110,111) — genau die
NULL-Einträge der Parser-Tabelle bei `0x00449B14` (Anzahl bei `0x00449CF4`).
Jede Familie belegt eine 16er-Gruppe: Vergleiche +0..5, Zuweisungen +8..14.

| Validierung | Ergebnis |
|-------------|----------|
| Wort → Felder → Wort über alle echten Regeln | **3704 / 3704 byte-exakt ✅** |
| Wort → **Text** → Wort, gesamte Regelbasis | **3704 / 3704 byte-exakt ✅** |
| Regelbasis → Text → neu compiliert → `.hrb` | **identisch, 0 Abweichungen ✅** |
| Testsuite | **33 / 33 grün** |

**Beide früheren Notationslücken sind geschlossen:**

*DT-Datumsfelder* (aus dem Encoder `0x00443D0C` gelesen):
```
Bits 24..27 = Monat     (0  = *)
Bits 21..23 = Wochentag (7  = *, sonst 0..6 = So..Sa)
Bits 16..20 = Tag       (0  = *)
Bits  6..10 = Stunde    (24 = *)
Bits  0.. 5 = Minute    (60 = *)
```
Textform jetzt vollständig: `DT==Sa, 24.12 18:30` bzw. `DT==*, *.* 05:00`.

*Timer-Bit 11 = „Load"-Flag:* es unterscheidet in dieser Datei-Generation
`ST`↔`LST` (G8/G9) und `LT`↔`LLT` (G10/G11). ParserV1000 verlegte LST/LLT
später auf eigene G-Werte (14..17). Textform: `ST3:=6.0` vs. `LST3:=6.0`.

**Neu:** `POST /api/rulebase/compile` `{source, replace?}` compiliert
Parser-Quelltext zu Regelworten und meldet Fehler zeilenweise. Gegenprobe:
`10.7.5==Bit-Konstante(1);` compiliert zu `0xD1071000` — genau dem Wort, das in
der gelieferten `RouleBase.hrb` an dieser Stelle steht.

Damit ist der Original-Workflow geschlossen:
**Text → `.hrb`** (Compiler) und **`.hrb` → Text** (`GET /api/rulebase/source`).

---

## Stufe 4 — Home Assistant (Add-on + MQTT-Entitäten)  ✅ Kette verifiziert

Ziel dieser Stufe: **keine Regeln mehr auf dem PC** — die einzelnen Entitäten
der Module werden von Home Assistant orchestriert. Dazu drei Bausteine:

| Baustein | Status | Nachweis |
|----------|--------|----------|
| **Entitäten-Ableitung aus der Regelbasis** (`src/entities.js`) | ✅ | 238 Entitäten aus der echten `RouleBase.hrb`: 20 Jalousien, 15 Dimmer, ~40 Schalter/Lichter, 114 Taster; `test/entities.test.js` |
| Jalousie-Erkennung inkl. **Laufzeit aus dem Timer-Preset** | ✅ | Muster `19.0.0:=0; 19.0.1:=1; LST9:=30.0` → gerades Bit = Richtung, ungerades = Motor, 30 s bzw. 50 s |
| Dimmer-Erkennung (Pegel `M.3` + Kommando `M.4`) | ✅ | `$30` Pegel setzen, `$17/$15` heller/dunkler, `$10` Stopp — identisch über alle 15 Dimmermodule |
| Merkerbits (Sub 1 / Sub 7) **nicht** als Geräte gemeldet | ✅ | `10.7.0` „schon gefahren heute", `31.1.x` Szenen-Flags → `internal`, standardmäßig aus |
| **Ausgangs-Schatten** (ganzes Sub-Byte, andere Bits bleiben) | ✅ | `test/bridge.test.js`: Bit 3 schalten löscht Bit 0 nicht; persistiert in `data/bridge-state.json` |
| **Jalousie-Laufzeit im Bridge** (Motor selbst stoppen, Positionsschätzung) | ✅ | die Module haben keine Endlagenrückmeldung; Tests fahren 1-s-Jalousie auf/zu/50 % |
| **MQTT-Discovery** (`src/hamqtt.js`) | ✅ | 190 Configs live gegen einen echten Broker: 20 `cover`, 18 `light`, 38 `switch`, 114 `binary_sensor`; `test/mqtt-e2e.test.js` |
| Gerätebaum: ein HA-Gerät je Modul + Master-Gerät mit Diagnose | ✅ | `heimauto_mod_<M>` mit `via_device` auf `heimauto_master` (Polling / Modulzahl / Betriebsart) |
| **Kommando → echter Bus-Frame** | ✅ | `heimauto/light_1a_0_0/set = ON` → `queueOutput(0x1A,0,0x01)` → `E5 1A 00 01 01` (der live verifizierte Frame) |
| **Eingang → HA-Zustand** | ✅ | Poll-Antwort → `LiveController.onInput` → `binary_sensor`; nur bei echter Änderung |
| Betriebsart `bridge` / `rules` / `both` | ✅ | `bridge`: `live.rules = false`, die 3704 Regeln laufen nicht; `rules`: unverändert originalgetreu (Standard der Standalone-Webapp) |
| **Home-Assistant-Add-on** (`addon/heimauto/`) | 🟡 | config.yaml/build.yaml/Dockerfile/run.sh + Ingress + `uart`/`usb` + `services: mqtt:want`; Autostart-Kette im Add-on-Layout lokal gestartet. **Ungeprüft:** der Docker-Image-Build selbst (kein Docker-Daemon hier) |
| Ingress-Tauglichkeit der Web-UI | ✅ | alle absoluten `/api/...`-Aufrufe und der WebSocket laufen über den Basis-Pfad der Seite |

**Neuer Tab „Home Assistant"** (`public/ha.js`): Betriebsart umschalten,
MQTT-Broker verbinden, und die Entitätenliste als Kuratierungsoberfläche —
melden/nicht melden, Typ korrigieren, Klarname + Bereich, Jalousie-Laufzeit,
Testknöpfe je Entität (derselbe Weg wie ein HA-Kommando). Overrides landen in
`data/entities.json`, die Klarnamen aus dem Tab „Bezeichnungen" werden
mitbenutzt (ein Bit, das „Licht" heißt, wird ein `light` statt eines `switch`).

**Zwei Betriebshinweise, die aus der Hardware folgen:**
* Ausgänge gehen nur raus, während das Polling läuft (der Master sendet nur im
  Poll-Burst) — sonst wird das Kommando verworfen und im Log vermerkt.
* Der Ausgangs-Schatten startet leer: das erste Kommando an ein Modul kann
  andere Ausgänge desselben Sub-Bytes ausschalten. Einmal alles über HA
  schalten, dann stimmt der Schatten (und er wird persistiert).

**Offen:** Docker-Build des Add-ons an echter Hardware; zeitgesteuerte Regeln
(Event-Key 8) müssen im `bridge`-Modus als HA-Automationen nachgebaut werden;
Dimmer-Rampe („heller, solange gedrückt") ist über MQTT nur als absoluter Pegel
abgebildet (`dimRamp()` existiert, ist aber nicht als HA-Entität gemeldet).

### Live-Zuordnung (Tab „Live-Zuordnung", 2026-08-25)

Das Problem aus dem ersten Praxistest: 150+ Entitäten sind in der Liste
theoretisch zuzuordnen, praktisch aber nicht — man müsste alle im Blick behalten.
Lösung: zu **jedem** eingehenden Bitwechsel schickt der Server ein
`ident`-Ereignis mit allem, was über die Adresse bekannt ist, und die Karte zeigt
es sofort an.

| Baustein | Status | Nachweis |
|----------|--------|----------|
| `src/identify.js`: Event-Key → Regelketten-Index | ✅ | 578 Ketten indiziert, keine geht verloren; `test/identify.test.js` |
| Eingangskarte: Adresse, Klarname, Entität, Event-Key, WENN/DANN-Ketten | ✅ | HWR-Taster `1A.0.6` → Event-Key `0xD06` → „HWR Licht (Relais)" |
| Ausgangsgeräte der Ketten aufgelöst (auch auf FREMDE Module) | ✅ | Küchentaster `12.0.7` → Dimmer auf Modul `0x11` |
| Jalousie erscheint als **ein** Gerät, nicht als zwei Bits | ✅ | `19.0.0`/`19.0.1` → `cover_19_0_0` |
| **Relative Adressen** (`00.x.y`) auf das auslösende Modul aufgelöst | ✅ | Test über mehrere Module: kein Ziel bleibt auf Modul `00` |
| Bei gelaufenen Regeln: geschaltete Geräte **mit Zustand** | ✅ | `1A.0 = 0x01` → „HWR Licht: EIN"; `19.0 = 0x02` → „fährt zu"; Dimmer → „Pegel 100 %" |
| **Bit-Maske der angefassten Ziele** | ✅ | ohne sie meldete ein Byte-Ausgang alle Geräte des Bytes — beim Dimmertaster erschien die Jalousie desselben Moduls als „Stopp" |
| Sofort-Benennung (Name + Bereich, Enter) wirkt überall | ✅ | schreibt `labels.json`, löst Neuableitung aus, sendet Discovery neu |
| **Adressen ohne Regel-Auslöser als Entität anlegen** | ✅ | `12.0.4` ist ein echter Taster, kommt aber in keiner Regel vor → „an HA melden" erzeugt einen `binary_sensor` (`entities.json`, `source: manual`) |
| Verlauf (30 Einträge), Filter „nur unbenannte", Ton, Tab-Marker | ✅ | im Browser gegen simulierte Modulantworten geprüft |
| `POST /api/bus/modules` — Modulliste ohne Scan setzen | ✅ | nötig am MOCK-Port (dort „antwortet" jede Adresse) und praktisch zum Pinnen |

Ablauf in der Praxis: Tab öffnen → „Zuordnung starten" → an der Wand drücken →
Name tippen → Enter. Der Klarname gilt sofort im Automationen-Tab, in der
Entitätenliste und in Home Assistant.
