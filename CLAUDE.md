# CLAUDE.md – Boßel-Simulator

Boßeln auf echten Straßen: Strecke aus OpenStreetMap wählen, zwei Teams werfen an einem Gerät,
3D-Ansicht aus Sicht des Werfers. UI-Texte deutsch, README englisch.

## Stack
- TypeScript + Vite, Three.js (3D), Leaflet (Karte), Capacitor (Android)
- `npm test` (Vitest) und `npm run build` (inkl. `tsc`) müssen fehlerfrei durchlaufen
- APK und Web-Vorschau baut `.github/workflows/android.yml` bei jedem Push auf `main`

## Konventionen
- Strecken-Koordinaten in Metern: x = Osten, y = Norden (`src/geo.ts`). In Three.js wird daraus
  (x, Höhe, −y) – immer über `w3()` in `world.ts`.
- `Course` (`src/osm/course.ts`) ist alle `STEP` = 2 m abgetastet; Position auf der Strecke als
  `s` (Weg) und `d` (seitlich, positiv = links). `project()` mit `hint` suchen lassen.
- Physik (`src/game/physics.ts`) ist rein und deterministisch (Seed) – Änderungen mit Tests absichern.
- Overpass/Nominatim brauchen eine Browser-Kennung; `curl` ohne `-A` bekommt 406.
- Kulisse aus OSM: `src/osm/scenery.ts` (Parser) → `Course.trees/areas/hedges/waterways/buildings`,
  aufgebaut in `src/game/world.ts`. Alle Kulissen-Felder außer `buildings`/`water` sind optional
  (ältere gespeicherte Strecken).
- Assets (CC0, Quellen in `CREDITS.md`) lädt `src/game/assets.ts` einmal. GLTFLoader entfernt Punkte aus
  Knochennamen (`UpperArm.R` → `UpperArmR`). Bäume/Tiere sind InstancedMeshes in 160-m-Kacheln (Sichtweite).
- Flächen am Boden schreiben keine Tiefe und werden per `renderOrder` zuerst gezeichnet – sonst
  verschwinden die tiefer liegenden Gräben.
- Ton wird in `src/game/audio.ts` per WebAudio erzeugt (keine Dateien), erst nach Berührung (`sound.unlock()`).
- Hindernisse (`src/game/obstacles.ts`) werden je Partie zufällig verteilt und an `simulateThrow` übergeben.
- Im Dev-Modus löst `window.boselThrow({ yaw, power })` einen Wurf aus (für Browser-Tests;
  Headless-Chromium rendert zu langsam für echte Wischgesten), `window.boselKescher()` startet das
  Minispiel, `?hindernisse=400` erhöht die Hindernisdichte.
