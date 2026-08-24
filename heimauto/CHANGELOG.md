# Changelog

## 1.0.0

- Erste Version als Home-Assistant-Add-on.
- Web-UI über Ingress (RouleEditor-Web: Editor, Automationen, Monitor, Simulator).
- Autostart: seriellen Port öffnen → Module scannen → Burst-Polling → Live-Betrieb.
- MQTT-Discovery für alle aus der Regelbasis abgeleiteten Entitäten
  (Jalousien, Dimmer, Licht/Schalter, Taster als `binary_sensor`).
- Betriebsart `bridge` (Home Assistant orchestriert, Regelbasis läuft nicht),
  `rules` (originalgetreu) und `both` (Übergang).
