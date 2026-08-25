#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -e

export HEIMAUTO_DATA_DIR=/data
export PORT=3000

# ---- serieller Port -------------------------------------------------------
SERIAL_PORT="$(bashio::config 'serial_port')"
if bashio::var.is_empty "${SERIAL_PORT}" || [ "${SERIAL_PORT}" = "null" ]; then
  # Erster USB-Seriell-Adapter, stabile by-id-Pfade bevorzugt.
  for cand in /dev/serial/by-id/* /dev/ttyUSB* /dev/ttyACM* /dev/ttyAMA*; do
    if [ -e "${cand}" ]; then SERIAL_PORT="${cand}"; break; fi
  done
fi
if bashio::var.has_value "${SERIAL_PORT}" && [ -e "${SERIAL_PORT}" ]; then
  export HEIMAUTO_SERIAL_PATH="${SERIAL_PORT}"
  bashio::log.info "Serieller Port: ${SERIAL_PORT}"
else
  bashio::log.warning "Kein serieller Port gefunden — die Web-UI startet, der Bus bleibt aus."
  bashio::log.warning "Verfügbar: $(ls /dev/tty* /dev/serial/by-id/* 2>/dev/null | tr '\n' ' ')"
fi

export HEIMAUTO_SERIAL_BAUD="$(bashio::config 'baud_rate')"
export HEIMAUTO_MODE="$(bashio::config 'mode')"
export HEIMAUTO_SCAN_START="$(bashio::config 'scan_start')"
export HEIMAUTO_SCAN_END="$(bashio::config 'scan_end')"

# ---- MQTT ------------------------------------------------------------------
# Feldweises Zusammenführen: was in den Optionen steht, gewinnt; alles Leere
# füllt der Home-Assistant-mqtt-Dienst (Mosquitto-Add-on) auf. Vorher wurden
# eigene Zugangsdaten überschrieben, sobald mqtt_host leer blieb.
opt() {
  local v
  v="$(bashio::config "$1")"
  if [ "${v}" = "null" ]; then v=""; fi
  printf '%s' "${v}"
}

MQTT_HOST="$(opt 'mqtt_host')"
MQTT_PORT="$(opt 'mqtt_port')"
MQTT_USER="$(opt 'mqtt_user')"
MQTT_PASS="$(opt 'mqtt_password')"

if bashio::services.available "mqtt"; then
  [ -z "${MQTT_HOST}" ] && MQTT_HOST="$(bashio::services mqtt 'host')"
  [ -z "${MQTT_PORT}" ] && MQTT_PORT="$(bashio::services mqtt 'port')"
  if [ -z "${MQTT_USER}" ] && [ -z "${MQTT_PASS}" ]; then
    # Nur zusammen übernehmen — ein halber Datensatz ergibt keinen Login.
    MQTT_USER="$(bashio::services mqtt 'username')"
    MQTT_PASS="$(bashio::services mqtt 'password')"
    bashio::log.info "MQTT-Zugangsdaten aus dem Home-Assistant-Dienst übernommen (kein eigener Benutzer nötig)."
  fi
  bashio::log.info "MQTT-Broker: ${MQTT_HOST}:${MQTT_PORT:-1883}"
elif [ -n "${MQTT_HOST}" ]; then
  bashio::log.info "MQTT-Broker aus den Add-on-Optionen: ${MQTT_HOST}:${MQTT_PORT:-1883}"
else
  bashio::log.warning "Kein MQTT-Broker konfiguriert und kein mqtt-Dienst verfügbar."
  bashio::log.warning "Mosquitto-Add-on installieren oder mqtt_host in den Optionen setzen."
fi

if [ -n "${MQTT_HOST}" ]; then
  export HEIMAUTO_MQTT_HOST="${MQTT_HOST}"
  export HEIMAUTO_MQTT_PORT="${MQTT_PORT:-1883}"
  if [ -n "${MQTT_USER}" ]; then export HEIMAUTO_MQTT_USER="${MQTT_USER}"; fi
  if [ -n "${MQTT_PASS}" ]; then export HEIMAUTO_MQTT_PASS="${MQTT_PASS}"; fi
fi
export HEIMAUTO_MQTT_BASE="$(bashio::config 'mqtt_base')"
export HEIMAUTO_MQTT_PREFIX="$(bashio::config 'discovery_prefix')"

bashio::log.info "Betriebsart: ${HEIMAUTO_MODE}"
cd /opt/heimauto/webapp
exec node server.js
