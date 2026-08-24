# Heimauto HomeBus Bridge — Add-on-Dokumentation

Dieses Add-on ist der HomeBus-Master: es pollt die Module über den
USB-Seriell-Adapter, meldet jede erkannte Entität per MQTT-Discovery an Home
Assistant und schaltet die Ausgänge auf HA-Befehl. Die komplette Web-UI
(Regelbasis-Editor, Automationen, Monitor, Simulator) läuft über Ingress —
Seitenleiste → **Heimauto**.

## 1. Installation

### Variante A — lokales Add-on (empfohlen für eine Anlage)

1. Build-Kontext erzeugen (auf dem Rechner mit diesem Repository):

   ```bash
   ./addon/heimauto/sync.sh
   ```

   Das kopiert die Webapp und die unversehrte `RouleBase.hrb` nach
   `addon/heimauto/src/`.

2. Den ganzen Ordner `addon/heimauto` als `heimauto` in das `/addons`-Verzeichnis
   der Home-Assistant-Installation kopieren (Samba-Add-on, SSH oder
   Studio-Code-Server), sodass `/addons/heimauto/config.yaml` existiert.

3. Home Assistant → **Einstellungen → Add-ons → Add-on-Store → ⋮ → Neu laden**.
   Unter „Lokale Add-ons" erscheint *Heimauto HomeBus Bridge* → **Installieren**.

### Variante B — eigenes Add-on-Repository

`addon/` ist bereits ein gültiges Add-on-Repository (`repository.yaml` +
Unterordner `heimauto/`). Nach `sync.sh` den Inhalt von `addon/` in ein
Git-Repository pushen und die Repository-URL im Add-on-Store unter
**⋮ → Repositories** hinzufügen.

## 2. Voraussetzungen

* **Mosquitto-Add-on** (oder ein anderer MQTT-Broker) + die
  **MQTT-Integration** in Home Assistant. Läuft Mosquitto als Add-on, werden
  Host, Port, Benutzer und Passwort automatisch übernommen (`services: mqtt:want`).
* Der **USB-Seriell-Adapter** am HomeBus. Er wird über `uart: true`/`usb: true`
  in den Container gemappt.

## 3. Optionen

| Option | Standard | Bedeutung |
|--------|----------|-----------|
| `serial_port` | *(leer)* | Gerätepfad. Leer = automatisch der erste Treffer aus `/dev/serial/by-id/*`, `/dev/ttyUSB*`, `/dev/ttyACM*`. Für einen festen Adapter besser den `by-id`-Pfad eintragen. |
| `baud_rate` | `115200` | Live an der Anlage verifiziert. |
| `mode` | `bridge` | `bridge` = Home Assistant orchestriert, die Regelbasis läuft **nicht**. `rules` = originalgetreu, die `.hrb` schaltet selbst. `both` = Übergangsbetrieb. |
| `scan_start` / `scan_end` | `0x10` / `0x4F` | Adressbereich des Modul-Scans beim Start (die Anlage antwortet auf 0x10–0x1C, 0x20–0x24, 0x30–0x31, 0x40–0x44). |
| `mqtt_host` / `mqtt_port` | *(leer)* / `1883` | Nur nötig, wenn der Broker **nicht** das Mosquitto-Add-on ist. |
| `mqtt_user` / `mqtt_password` | *(leer)* | dito. |
| `mqtt_base` | `heimauto` | Basis-Topic für Status und Kommandos. |
| `discovery_prefix` | `homeassistant` | MQTT-Discovery-Prefix (muss zur MQTT-Integration passen). |

## 4. Was beim Start passiert

```
seriellen Port öffnen → Module scannen (scan_start..scan_end)
   → Burst-Polling starten (alle Module in einem Write, ~110 ms)
   → Live-Betrieb (Eingänge lesen)
   → MQTT verbinden, Discovery senden, Zustände veröffentlichen
```

Jeder Schritt ist optional: ohne Adapter oder ohne Broker startet die Web-UI
trotzdem, und im Add-on-Log steht, was fehlt.

## 5. Welche Entitäten entstehen

Die Entitäten werden **aus der Regelbasis abgeleitet** — nur sie weiß, was an
einem Modulausgang hängt (ein Poll beantwortet nur die Eingänge):

| HA-Typ | Erkennungsmuster in der Regelbasis |
|--------|-----------------------------------|
| `cover` (Jalousie) | zwei benachbarte Bits eines Sub-Bytes in einer Kette + Timer-Laden, z. B. `19.0.0:=0; 19.0.1:=1; LST9:=30.0`. Gerades Bit = Richtung (1 = auf), ungerades = Motor läuft, **Laufzeit = größtes Timer-Preset** |
| `light` mit Helligkeit | Dimmer-Protokoll `M.3` (Pegel 0…0x40) + `M.4` (`$30` Pegel setzen, `$17/$15` heller/dunkler, `$10` Stopp) |
| `switch` / `light` | jedes weitere zugewiesene Bit von Sub 0 (Relaiskontakte) |
| `binary_sensor` | die Eingänge: jeder Auslöser der Regelbasis mit Sub 0 oder ≥ 2 (Sub 1 sind Timer-Ablaufevents, keine Taster) |

Aus der gelieferten `RouleBase.hrb` ergibt das **20 Jalousien, 15 Dimmer,
~40 Schalter/Lichter und 114 Taster** (238 erkannt, 190 gemeldet). Merkerbits
der Regelbasis (Sub 1 / Sub 7, z. B. „schon gefahren heute") werden erkannt,
aber standardmäßig **nicht** gemeldet.

Zusätzlich meldet sich das Add-on selbst als Gerät *Heimauto HomeBus Master* mit
den Diagnose-Entitäten „HomeBus Polling", „HomeBus Module" und „Betriebsart".

### Kuratieren

Web-UI → Tab **Home Assistant**: Häkchen „melden", Typ korrigieren, Klarnamen
und Bereich setzen, Jalousie-Laufzeit anpassen, jede Entität direkt testen.
**Speichern & melden** schreibt `/data/entities.json` und sendet die Discovery
neu. Namen aus dem Tab „Bezeichnungen" (Automationen) werden mitbenutzt: heißt
ein Bit „… Licht …", wird daraus ein `light` statt eines `switch`.

## 6. MQTT-Topics

```
heimauto/status                       online | offline (LWT)
heimauto/<id>/state                   Zustand (Text bzw. JSON beim Dimmer)
heimauto/<id>/set                     Kommando  ON | OFF | OPEN | CLOSE | STOP | {"state":…,"brightness":…}
heimauto/<id>/position                Jalousie 0…100
heimauto/<id>/set_position            Jalousie-Ziel 0…100
homeassistant/<typ>/heimauto/<id>/config   Discovery
```

## 7. Wichtige Betriebshinweise

* **Ausgänge brauchen laufendes Polling.** Der Master sendet nur innerhalb
  seines Poll-Bursts. Läuft das Polling nicht, wird ein Kommando verworfen und
  im HA-Log des Tabs vermerkt.
* **Jalousie-Endlagen gibt es nicht.** Die Module haben keine Rückmeldung; die
  Laufzeit kommt aus der Regelbasis (z. B. 30 s / 50 s) und das Add-on stoppt
  den Motor selbst. Die Position ist eine Schätzung — nach einem Neustart erst
  wieder verlässlich, wenn die Jalousie einmal ganz auf oder ganz zu gefahren ist.
* **Ausgangs-Schattenzustand.** Ein HomeBus-Frame trägt immer ein ganzes
  Sub-Byte. Das Add-on merkt sich jedes geschriebene Byte in
  `/data/bridge-state.json`, damit das Schalten eines Relais die anderen sieben
  desselben Moduls nicht löscht. Beim allerersten Start ist der Schatten leer:
  das erste Kommando an ein Modul kann daher andere, vorher per Hand
  eingeschaltete Ausgänge dieses Bytes ausschalten. Einmal alles über HA
  schalten — danach stimmt der Schatten.
* **Betriebsart `bridge`** heißt: die 3704 Regeln der `.hrb` laufen nicht. Damit
  entfallen auch die zeitgesteuerten Regeln (Rolladen 9:30, Außenlicht) — die
  gehören dann als Automationen nach Home Assistant.

## 8. Fehlersuche

| Symptom | Ursache / Abhilfe |
|---------|-------------------|
| „Kein serieller Port gefunden" | Adapter nicht eingesteckt oder nicht gemappt. Das Log listet die vorhandenen `/dev/tty*`; den passenden Pfad in `serial_port` eintragen. |
| Keine Entitäten in HA | MQTT-Integration in HA nicht eingerichtet, oder `discovery_prefix` weicht ab. Im Tab „Home Assistant" → **Discovery neu senden**. |
| Entitäten da, aber „nicht verfügbar" | `heimauto/status` steht auf `offline` → Add-on läuft nicht. |
| Schalten ohne Wirkung | „HomeBus Polling" muss `ON` sein und das Modul im Scan gefunden worden sein (Diagnose-Sensor „HomeBus Module"). |
| `serialport nicht ladbar` beim Build | Das Image fällt auf MOCK zurück; Add-on neu bauen (⋮ → Neu erstellen). |
