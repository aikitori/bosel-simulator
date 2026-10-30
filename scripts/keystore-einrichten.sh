#!/usr/bin/env bash
# Einmalig: festen Signaturschlüssel für das APK erzeugen und als Secrets ins GitHub-Repo legen.
# Aufruf im Projektordner:  bash scripts/keystore-einrichten.sh
# Braucht: keytool (kommt mit Java/JDK) und – für das automatische Eintragen – die GitHub-CLI `gh`
# (vorher einmal `gh auth login`). Ohne `gh` werden die Werte zum Abtippen ausgegeben.
set -euo pipefail

DIR="${SIGNATUR_DIR:-${HOME}/bosel-simulator-signatur}"
KEYSTORE="${DIR}/bosel-simulator.jks"
ALIAS="bosel"

if [ -e "$KEYSTORE" ]; then
  echo "Es gibt schon einen Schlüssel: $KEYSTORE"
  echo "Nicht neu erzeugen – sonst lassen sich Updates nicht mehr über die installierte App spielen."
  exit 1
fi
command -v keytool >/dev/null || { echo "keytool fehlt: bitte ein JDK installieren (z. B. Temurin 21)."; exit 1; }

mkdir -p "$DIR"
chmod 700 "$DIR"
PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"

# PKCS12: Schlüssel- und Keystore-Passwort sind gleich
keytool -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -alias "$ALIAS" \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PASSWORD" -keypass "$PASSWORD" \
  -dname "CN=Bosel-Simulator" >/dev/null
echo "$PASSWORD" > "${DIR}/passwort.txt"
chmod 600 "$KEYSTORE" "${DIR}/passwort.txt"
BASE64="$(base64 < "$KEYSTORE" | tr -d '\n')"

echo "Schlüssel erzeugt: $KEYSTORE (Passwort in ${DIR}/passwort.txt)"
echo "WICHTIG: Diesen Ordner sicher aufheben (z. B. auf einem USB-Stick). Geht er verloren,"
echo "muss die App einmal neu installiert werden und gespeicherte Strecken sind weg."

if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  printf '%s' "$BASE64" | gh secret set ANDROID_KEYSTORE_BASE64
  printf '%s' "$PASSWORD" | gh secret set ANDROID_KEYSTORE_PASSWORD
  printf '%s' "$ALIAS" | gh secret set ANDROID_KEY_ALIAS
  printf '%s' "$PASSWORD" | gh secret set ANDROID_KEY_PASSWORD
  echo "Die vier Secrets sind im Repo eingetragen. Der nächste Merge auf main baut ein signiertes APK."
else
  echo
  echo "Die GitHub-CLI ist nicht angemeldet. Bitte im Repo unter Settings → Secrets and variables → Actions"
  echo "diese vier 'Repository secrets' anlegen:"
  echo "  ANDROID_KEYSTORE_BASE64 = (Inhalt der Datei ${DIR}/keystore-base64.txt)"
  echo "  ANDROID_KEYSTORE_PASSWORD = $PASSWORD"
  echo "  ANDROID_KEY_ALIAS = $ALIAS"
  echo "  ANDROID_KEY_PASSWORD = $PASSWORD"
  printf '%s' "$BASE64" > "${DIR}/keystore-base64.txt"
  chmod 600 "${DIR}/keystore-base64.txt"
fi
