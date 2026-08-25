# RouleEditor Web

Plattformunabhängige Node.js-Webanwendung, die die Funktionen von
`RouleEditorV2103.exe` (Borland Delphi 3, HomeBus-Hausautomatisierung)
nachbildet **und** die serielle Konfiguration frei einstellbar macht.

Basiert auf dem Reverse-Engineering in [`../re/docs/`](../re/docs/); der
`.hrb`-Codec ist **byte-exakt** gegen die Originaldatei verifiziert.

## Start

```bash
cd webapp
npm install        # express, ws, serialport (nativ)
npm start          # http://localhost:3000   (PORT=... zum Ändern)
```

Läuft nativ auf modernen Architekturen (macOS/Apple Silicon, Linux, Windows,
x86-64 und ARM) — kein Wine, kein 32-Bit-Zwang.

```bash
npm test           # verifiziert den .hrb-Codec gegen ../RouleBase.hrb
```

## Funktionen (Originalprogramm nachgebildet)

| Original (Delphi)            | Web-Entsprechung |
|------------------------------|------------------|
| `TDlgEinstellungen` (Schnittstelle) | **Einstellungen** — Port, Baudrate, Parität, Datenbits, Stopbits, RTS/CTS |
| `TEditForm` (Regelbasis)     | **Editor** — `RouleBase.hrb` laden/bearbeiten/importieren/exportieren/speichern |
| RS-232 RX/TX                 | **Monitor** — Live-Empfang/Sendung (WebSocket), Hex-Senden |
| `TSimulationForm`            | **Simulator** — Regelbasis softwareseitig ausführen, Modul-/Timer-Zustände, Ereignis-Log |
| *(neu)*                      | **Home Assistant** — Betriebsart, MQTT-Broker, Entitätenliste (melden/Typ/Name/Bereich/Laufzeit, Testknöpfe) |
| *(neu)*                      | **Live-Zuordnung** — Taster drücken → Adresse, Entität, Regelketten und geschaltete Geräte sofort sehen, Klarname direkt vergeben |

### Erweiterungen gegenüber dem Original
- **Frei konfigurierbare Schnittstelle:** statt fester Liste `COM1..COM8` werden
  vorhandene Ports **automatisch erkannt** (USB-Seriell etc.), jede
  Baudrate/Parität/Datenbit/Stopbit-Kombination ist wählbar.
- **MOCK-Loopback:** eingebauter Simulator-Port — die App ist ohne Hardware voll
  nutzbar (Echo + periodischer HomeBus-artiger Heartbeat).
- **Live-Streaming** aller RX/TX-Daten an beliebig viele Browser-Clients (WS).
- **Byte-exakter Ex-/Import** plus Editier-Modus mit automatischer
  Prüfsummen-Neuberechnung (`Export (rebuild ⊕)`).
- Plattform- und browserbasiert, kein Installations- oder Lizenz-Node-Lock.
- **Home-Assistant-Anbindung:** die Anlage wird per MQTT-Discovery als Jalousien,
  Dimmer, Lichter/Schalter und Taster gemeldet und von HA orchestriert; als
  Add-on paketiert unter [`../addon/heimauto`](../addon/heimauto/DOCS.md).

## Home Assistant

Betriebsart `bridge` (Standard im Add-on) heißt: die 3704 Regeln der `.hrb`
laufen **nicht** — Home Assistant schaltet die Entitäten. `rules` ist das
originalgetreue Verhalten (Standard der Standalone-Webapp), `both` der Übergang.

```bash
# Standalone mit MQTT und Autostart der ganzen Kette
HEIMAUTO_MODE=bridge \
HEIMAUTO_SERIAL_PATH=/dev/cu.usbserial-110 HEIMAUTO_SERIAL_BAUD=115200 \
HEIMAUTO_MQTT_HOST=192.168.1.10 HEIMAUTO_MQTT_USER=ha HEIMAUTO_MQTT_PASS=… \
node server.js
```

| Umgebungsvariable | Bedeutung |
|-------------------|-----------|
| `HEIMAUTO_DATA_DIR` | Datenverzeichnis (Add-on: `/data`); Standard `webapp/data` |
| `HEIMAUTO_MODE` | `bridge` \| `rules` \| `both` |
| `HEIMAUTO_SERIAL_PATH` / `_BAUD` | Autostart des Ports (leer = kein Autostart) |
| `HEIMAUTO_SCAN_START` / `_END` | Adressbereich des Modul-Scans (`0x10`/`0x4F`) |
| `HEIMAUTO_MQTT_HOST` / `_PORT` / `_USER` / `_PASS` | Broker (leer = kein Autoconnect) |
| `HEIMAUTO_MQTT_BASE` / `_PREFIX` | Basis-Topic (`heimauto`) / Discovery-Prefix (`homeassistant`) |

Details, Entitäten-Ableitung und Betriebshinweise:
[`addon/heimauto/DOCS.md`](../addon/heimauto/DOCS.md) und `STATUS.md` (Stufe 4).

## Architektur

```
webapp/
  server.js              Express (REST) + ws (WebSocket) + statisches Frontend
  src/
    hrb.js               .hrb-Codec (byte-exakt verifiziert)
    opcodes.js           32-Bit-Regelwort: Felder + zuverlässige Klassifikation
    serialManager.js     serialport-Wrapper + MOCK-Fallback, EventEmitter
    entities.js          Entitäten aus der Regelbasis ableiten (Jalousie/Dimmer/Schalter/Taster)
    bridge.js            Entität ↔ HomeBus-Ausgangsbyte, Jalousie-Laufzeit, Eingangszustände
    hamqtt.js            MQTT-Discovery + Kommando-Abonnements für Home Assistant
    identify.js          Live-Zuordnung: Eingangsadresse → Name, Entität, Regelketten, Ausgangsgeräte
    simulator.js         Zustandsmodell (48×16 Module, ST/LT/DT) + Regel-Engine
  public/                index.html · style.css · app.js (Vanilla-ES-Module, kein Build)
  test/hrb.test.js       node:test, prüft Round-Trip & Prüfsumme
  data/                  Ziel für Server-seitiges Speichern
```

### REST-API (Auszug)
```
GET  /api/opcodes                 Opcode-Tabelle + serielle Auswahlmöglichkeiten
GET  /api/rulebase                Zusammenfassung + Index + Runs
GET  /api/rulebase/rules          alle Regelworte, dekodiert
PUT  /api/rulebase/rules/:i       Regel setzen (Rohwort oder Felder)
POST /api/rulebase/rules          Regel anhängen
DEL  /api/rulebase/rules/:i       Regel löschen
POST /api/rulebase/import         .hrb hochladen (octet-stream)
GET  /api/rulebase/export[?rebuild=1]   .hrb herunterladen
POST /api/rulebase/save           serverseitig nach data/ speichern
GET  /api/serial/ports            Ports auflisten (echt + MOCK)
POST /api/serial/open|close       Port mit Konfiguration öffnen/schließen
POST /api/serial/send  {hex}      Bytes senden
GET  /api/sim/state               Simulator-Zustand
POST /api/sim/run|inject|reset    Simulator steuern
WS   /ws                          Live-Events: rx, tx, serial-status, sim-state
```

## Genauigkeit / Grenzen (ehrlich dokumentiert)

**Exakt und verifiziert:**
- `.hrb`-Containerformat (Index · Terminator · Regelworte · XOR-Balancer),
  Prüfsumme `XOR == 0x15`, byte-exakter Round-Trip und Rebuild.
- Bitfeld-Zerlegung jedes 32-Bit-Regelworts (Event-Typ, dstSub/dstBit,
  srcSub/srcBit, op5, operand12).
- Serielle Parameter (Baud/Parität/Datenbits/Stopbits) gemäß Original-DCB-Setup.

**Best-effort / bewusst vereinfacht:**
- Die vollständige **83-Opcode-Mnemonik** wird nicht pro Wort rekonstruiert: der
  Opcode ist im Original über mehrere Bitfelder verteilt und seine exakte
  Operanden-Führung liegt im Firmware-Interpreter (`RBExecCmd`, 0x0046929C).
  Zuverlässig angezeigt werden Event-Klasse (Modul/Timer-DT) und die
  Operationsgruppe; zum Editieren sind **Rohwort + Bitfelder maßgeblich**
  (byte-exakt). Die 83er-Tabelle liegt als Befehlssatz-Referenz bei.
- Der **Simulator** ist ein struktureller Zustands-/Ausführungs-Nachbau (ideal
  zum Prüfen von Regeländerungen), kein zyklen-exaktes Firmware-Replikat.
- Der **HomeBus-Rahmen** (Byte-Zustandsmaschine 0x00470674) ist für den Monitor
  als Roh-Hex umgesetzt; eine vollständige Frame-Dekodierung kann bei Bedarf
  ergänzt werden.

Diese Grenzen betreffen ausschließlich die *Interpretation* der Regeln; das
Laden, Bearbeiten, Sichern und Übertragen der Regelbasis ist vollständig und
originalgetreu.
