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
- Datenquellen: Route von OSRM (FOSSGIS, Fahrrad-Profil, `src/osm/osrm.ts`). Grundlandschaft (Häuser,
  Flächen, Gewässer, Straßen mit Art/Belag) aus VersaTiles-Vektorkacheln z14 (`src/osm/tiles.ts`), übersetzt
  in OSM-artige Elemente, damit `scenery.ts`/`routing.ts` gleich bleiben. Overpass nur noch im Hintergrund
  für Einzelbäume, Baumreihen, Hecken (`fetchExtras`, gecacht als Korridore) und als Routing-Notlösung.
  Kacheln und Korridore liegen 60 Tage in IndexedDB (`src/osm/cache.ts`). Keine `.ru`-Server verwenden.
- Dev-Server nicht mit `pkill -f "vite …"` beenden – das trifft die eigene Shell; stattdessen PID merken.
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
- `main.ts` lädt `Game`/Assets und `MapPicker` per `import()` nach (Three.js/Leaflet nicht im Start-Bundle).
  Die Zurück-Taste fängt ein zusätzlicher Verlaufseintrag ab (`trapBack`), solange Spiel oder Karte offen sind.
- Laufende Partie liegt nach jedem Wurf in `localStorage` (`saveMatch`, nur Streckenschlüssel + Seed für die
  Hindernisse; die Strecke selbst kommt aus der Streckenliste bzw. `demoCourse()`). Rekorde je Strecke: `submitRecord`.
