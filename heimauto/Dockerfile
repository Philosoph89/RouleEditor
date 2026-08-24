ARG BUILD_FROM
FROM $BUILD_FROM

ENV LANG=C.UTF-8 \
    NODE_ENV=production \
    HEIMAUTO_DATA_DIR=/data

COPY src/ /opt/heimauto/
WORKDIR /opt/heimauto/webapp

# Node 18 aus Debian bookworm. python3/make/g++ werden nur gebraucht, falls für
# das native serialport-Modul kein passender Prebuild existiert; danach fliegen
# die Compiler wieder raus (python3 bleibt: im Basis-Image hängen Pakete daran).
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends nodejs npm ca-certificates python3 make g++; \
    if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi; \
    if node -e "require('serialport')" 2>/dev/null; then \
      echo "serialport: OK"; \
    else \
      echo "WARNUNG: serialport nicht ladbar — das Add-on läuft nur im MOCK-Modus"; \
    fi; \
    npm cache clean --force; \
    apt-get purge -y --auto-remove make g++; \
    rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

COPY run.sh /run.sh
RUN chmod a+x /run.sh

LABEL io.hass.name="Heimauto HomeBus Bridge" \
      io.hass.description="HomeBus-Master mit MQTT-Discovery für Home Assistant" \
      io.hass.type="addon"

CMD [ "/run.sh" ]
