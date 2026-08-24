#!/usr/bin/env bash
# Kopiert die Webapp in den Build-Kontext des Add-ons (src/).
# Danach kann addon/heimauto/ direkt als lokales Add-on nach /addons kopiert
# oder in ein Add-on-Repository committet werden.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../.." && pwd)"

rm -rf "${here}/src"
mkdir -p "${here}/src/webapp"

# Webapp ohne node_modules und ohne die lokalen Laufzeitdaten
for item in package.json package-lock.json server.js src public README.md STATUS.md test; do
  cp -R "${root}/webapp/${item}" "${here}/src/webapp/"
done
# Unversehrte Original-Regelbasis: der Server nutzt sie als Reset-Quelle
# (webapp/../RouleBase.hrb).
cp "${root}/RouleBase.hrb" "${here}/src/RouleBase.hrb"

echo "Build-Kontext aktualisiert: ${here}/src"
du -sh "${here}/src"
