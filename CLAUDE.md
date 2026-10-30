# CLAUDE.md – Boßel-Simulator

Boßeln auf echten Straßen: Strecke aus OpenStreetMap wählen, zwei Teams werfen an einem Gerät,
3D-Ansicht aus Sicht des Werfers. UI-Texte deutsch, README englisch.

## Stack
- TypeScript + Vite, Three.js (3D), Leaflet (Karte), Capacitor (Android)
- `npm test` (Vitest) und `npm run build` (inkl. `tsc`) müssen fehlerfrei durchlaufen
- APK und Web-Vorschau baut `.github/workflows/android.yml` bei jedem Push auf `main`

## Konventionen
- Strecken-Koordinaten in Metern: x = Osten, y = Norden (`src/geo.ts`). In Three.js wird daraus
  (x, Höhe, −y) – immer über `w3()` in `Scene3D.ts`.
- `Course` (`src/osm/course.ts`) ist alle `STEP` = 2 m abgetastet; Position auf der Strecke als
  `s` (Weg) und `d` (seitlich, positiv = links). `project()` mit `hint` suchen lassen.
- Physik (`src/game/physics.ts`) ist rein und deterministisch (Seed) – Änderungen mit Tests absichern.
- Overpass/Nominatim brauchen eine Browser-Kennung; `curl` ohne `-A` bekommt 406.
- Im Dev-Modus löst `window.boselThrow({ yaw, power })` einen Wurf aus (für Browser-Tests;
  Headless-Chromium rendert zu langsam für echte Wischgesten).
