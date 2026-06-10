# Alignment Spot

Find **where to stand** so the sun or moon visually aligns with a landmark —
a tower, a torii, a summit — for that perfect photo. Inverse of the usual
sun-position apps: you pick the *target*, the app gives you the *spot*.

- Tap the map to place the target, enter its height.
- Pick ☀️ / 🌙, a date, and scrub the time slider.
- The map shows the **align spot** for that instant, the day's **band** (how
  the spot sweeps as time passes), and grays out stretches where terrain
  blocks the sightline.
- Alignment modes: disk bottom touching the tip (diamond-Fuji style, default)
  or disk centered on the tip.

## Tech

Static PWA — no backend, no API keys.

| Piece | Choice |
|---|---|
| Map | MapLibre GL JS + [OpenFreeMap](https://openfreemap.org) |
| Ephemeris | [astronomy-engine](https://github.com/cosinekitty/astronomy) |
| Elevation | AWS Terrain Tiles (terrarium), decoded in-browser |
| Build / tests | Vite + TypeScript + vitest |

Solver details in [docs/specs/2026-06-10-alignment-spot-design.md](docs/specs/2026-06-10-alignment-spot-design.md).

## Dev

```bash
npm install
npm run dev      # local dev server
npm test         # vitest
npm run build    # typecheck + production build to dist/
```

Deployed to GitHub Pages via `.github/workflows/deploy.yml` on push to `main`.
