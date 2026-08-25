# Changelog

## 1.1.0

- **Absturz behoben:** kuratierte Einträge in `/data/entities.json` aus einer
  älteren Ableitung (z. B. `switch_40_0_0`, jetzt `light_40_0_0`) wurden zu
  Entitäten ohne Adresse und beendeten beim MQTT-Discovery den ganzen Prozess.
  Solche Einträge ziehen jetzt automatisch auf die neue Entitäts-ID um (Name,
  Raum, Typ und „melden" bleiben erhalten); was sich nicht zuordnen lässt, wird
  verworfen und protokolliert. Zusätzlich ist das Discovery je Entität
  abgesichert, und eine unbehandelte Ausnahme beendet das Add-on nicht mehr.
- **Anschlussdokumentation der Anlage eingearbeitet** (391 Klemmen): Klarnamen,
  Geräteklassen (Fensterkontakte, Rauchmelder, Bewegungsmelder,
  Sabotagekontakte, Steckdosen) und 16 Räume. 143 Anschlüsse, die die alte
  Konfiguration nie benutzt, sind ergänzt — darunter drei Flurlichter und die
  komplette Sensorik.
- **Lüftung** als `fan` mit 16 Stufen (Register `1C.0`), inklusive der
  Stufen-LEDs an den Tastern; `1C.7` als 8-stelliger Betriebsart-Wähler.
- **Hardwaretyp je Modul** (Dimmer/Relais/Analog mit Version) am
  Home-Assistant-Gerät.
- **Neuer Tab „Live-Zuordnung":** Taster drücken und sofort sehen, welche
  Adresse, Entität und Regelkette dahinter steckt — mit Sofort-Umbenennung.
- Modulliste ohne Scan setzbar (`POST /api/bus/modules`).

## 1.0.0

- Erste Version als Home-Assistant-Add-on.
- Web-UI über Ingress (RouleEditor-Web: Editor, Automationen, Monitor, Simulator).
- Autostart: seriellen Port öffnen → Module scannen → Burst-Polling → Live-Betrieb.
- MQTT-Discovery für alle aus der Regelbasis abgeleiteten Entitäten
  (Jalousien, Dimmer, Licht/Schalter, Taster als `binary_sensor`).
- Betriebsart `bridge` (Home Assistant orchestriert, Regelbasis läuft nicht),
  `rules` (originalgetreu) und `both` (Übergang).
