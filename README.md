<div align="center">

# Boßel-Simulator

**Boßeln on real roads – pick any route from OpenStreetMap and play it in 3D.**

[![Build](https://github.com/aikitori/bosel-simulator/actions/workflows/android.yml/badge.svg)](https://github.com/aikitori/bosel-simulator/actions/workflows/android.yml)
[![Latest release](https://img.shields.io/github/v/release/aikitori/bosel-simulator)](https://github.com/aikitori/bosel-simulator/releases/latest)

[**Download APK**](https://github.com/aikitori/bosel-simulator/releases/latest/download/bosel-simulator.apk) · [**Play in the browser**](https://aikitori.github.io/bosel-simulator/)

<img src="docs/screenshot-aim.png" width="260" alt="Aiming"> <img src="docs/screenshot-throw.png" width="260" alt="Throwing">

</div>

## Features

- **Real routes:** tap start and finish on the map, extra taps add detours. The route follows OSM roads.
- **Built from OpenStreetMap:** road width and surface (asphalt, clinker, gravel, dirt), houses with gabled or hipped roofs and brick or plaster walls, single trees, tree rows, woods, hedges, meadows with cows and sheep, ditches and canals.
- **3D thrower view:** animated character with run-up and underhand throw, the camera chases the ball.
- **Physics:** the ball bounces, rolls, drifts to the road edge and runs straight on in bends – right into the ditch.
- **Random obstacles:** potholes knock the ball off course, puddles slow it down, stones deflect it.
- **Kloot in de Sloot:** if the ball lands in the ditch, fish it out with the net in a mini-game – or take a penalty throw.
- **Feel:** synthesized sound (throw, bounces, rolling, splash), vibration, ball trail, fly-over of the course before each match.
- **Two teams on one device:** take turns or play the traditional way (whoever is behind throws). Optional player names per team.
- **Offline practice course** and saved routes.

## How to play

1. Put your finger on the screen: the thrower starts the run-up and swings back.
2. Flick upwards and let go when the marker is in the green zone – the release moment sets the launch angle. Too early slams the ball into the road, too late lobs it high. The faster the flick, the farther; flick at an angle to aim. Mind the bends!
3. If the ball ends up in the ditch, fish it out with the net (move with your finger, release to scoop – not while it's under water). Three tries in ten seconds, otherwise +1 penalty throw. Play continues where the ball left the road.
4. The team that reaches the finish with fewer throws wins. Tap to fast-forward a throw.

## Development

```
src/
  osm/     Overpass queries, routing (Dijkstra), course model, OSM scenery, demo course
  game/    physics, obstacles, rules, Three.js scene and world, swipe input, HUD, net mini-game
  map/     Leaflet route picker
test/      Vitest tests (physics, rules, routing on OSM sample data)
android/   Capacitor Android project
```

```sh
npm install
npm run dev        # http://localhost:5173
npm test
npm run build
npm run android:sync
```

Every push to `main` builds a signed APK release and the web version (GitHub Pages).

## Credits

Models by [Quaternius](https://quaternius.com), textures by [Poly Haven](https://polyhaven.com) – all CC0, see [CREDITS.md](CREDITS.md).
Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
