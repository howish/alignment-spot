# Alignment Spot — design

2026-06-10. Brainstormed with howish over Discord (channel "Alignment spot app").

## Purpose

Photo-planning PWA: given a celestial body (sun or moon), a ground structure
(position + height), and a date, compute **where to stand** so the body and the
structure visually overlap in a photograph — the *align spot* — and draw the
*band* showing how that spot moves as time (and date) changes.

Same problem family as PhotoPills' "Find" tool, but inverse-first, free, and
web-native.

## Decisions (from brainstorm Q&A)

| Question | Decision |
|---|---|
| Platform | Web + PWA (no native app, no store) |
| Band axes | Both: time-of-day slider **and** date picker (flip days, no multi-day overlay in v1) |
| Structure types | Both man-made and mountains → DEM required |
| Region | Global-capable; Taiwan top priority, Japan second. Default map view = Taiwan |
| Alignment definition | Switchable setting; default = **disk bottom touching structure tip** (diamond-Fuji style); alt = disk center on tip |
| Architecture | Fully static client-side PWA, GitHub Pages, zero backend, zero API keys |

## Stack

- **Build**: Vite + TypeScript (vanilla, no framework)
- **Map**: MapLibre GL JS + OpenFreeMap vector tiles (key-free, no usage cap)
- **Ephemeris**: `astronomy-engine` (topocentric az/el for sun & moon, parallax,
  apparent semi-diameter, refraction)
- **Elevation**: AWS Terrain Tiles (terrarium PNG, `s3.amazonaws.com/elevation-tiles-prod`),
  decoded in-browser via canvas, cached in memory + Cache Storage
- **Tests**: vitest (solver + DEM decode are pure functions)
- **Deploy**: GitHub Pages (static)

## Solver

Runs in a Web Worker. For each sample time `t` (1-min steps across the day's
window where the body is above the horizon):

1. Compute body topocentric azimuth `Az(t)` and refracted altitude `h(t)` at
   the structure's location (observer-to-structure distance ≤ 30 km makes the
   per-position difference negligible, even for the moon: < 0.005°).
2. Target apparent altitude of the structure tip:
   - mode `bottom-touch` (default): `h_tip = h(t) − semidiameter(t)` so the
     disk's lower limb sits on the tip
   - mode `center`: `h_tip = h(t)`
3. The observer must be on the ray from the structure along back-azimuth
   `Az(t) + 180°`. March outward (50 m steps, refined by bisection) sampling
   DEM elevation at each step. At distance `d`:

   ```
   apparent_alt(d) = atan( (E_struct + H − E_obs(d) − eye) / d ) − curvature(d)
   curvature(d)    = d / (2 · R_eff),  R_eff = R_earth / (1 − k), k = 0.13
   ```

   `E_struct` = DEM at structure base, `H` = structure height, `E_obs` = DEM at
   observer point, `eye` = observer eye height (setting, default 1.6 m).
4. Collect **all** zero crossings of `apparent_alt(d) − h_tip` within
   [2·H... 30 km] — hilly terrain can give several. Nearest = primary spot.
5. Line-of-sight check: while marching, track the max angular obstruction
   between observer and structure tip; if terrain blocks the sightline the spot
   is flagged `occluded` (rendered gray/dashed).
6. Band geometry: per-time tolerance segment = the `d` solutions at
   `h_tip ± semidiameter(t)` (where the disk still overlaps the tip). The day's
   band = polygon sweeping those segments over time; the time slider highlights
   the instant spot.

Solutions are skipped when `h(t) ≤ 0.1°` (below horizon / too low to matter)
or when no `d` in range satisfies the equation (body too high → spot would be
closer than 2·H; or too far → beyond 30 km).

## UI (single screen)

- Fullscreen map, default center Taiwan (23.7°N 121.0°E, z7).
- Tap map → place structure pin → bottom sheet asks height (m).
- Bottom bar: ☀️/🌙 toggle · date picker (±1 day swipe) · time slider
  (1-min steps over the body's up-window).
- Map overlays: instant spot marker · day band (width = disk tolerance,
  occluded stretches gray-dashed) · sightline structure→spot.
- Spot tap → detail card: distance, azimuth, body altitude, link to Google Maps
  directions.
- Settings (gear): alignment mode A/B, eye height, refraction on/off, language.
- i18n: zh-TW default, ja / en switchable.

## Error handling

- Body never above usable altitude that day → slider shows "no alignment
  possible" state.
- DEM tile fetch fails → flat-terrain fallback (E_obs = E_struct base guess of
  0 m) + visible "approximate (no elevation data)" badge.
- All solutions out of range → "too far / too close" notice on the slider.

## PWA

- `manifest.webmanifest` + service worker: cache-first app shell, runtime
  cache for map/DEM tiles (LRU-ish cap). Installable; works offline at a
  location whose tiles were previously viewed.

## Testing

- Solver unit tests: flat-earth analytic cases (100 m tower, sun alt 5.71° →
  d ≈ 1 km), curvature correction magnitude, alignment-mode offsets,
  multi-crossing terrain fixture, occlusion fixture.
- DEM: terrarium decode known-pixel test, bilinear sampling test.
- Ephemeris sanity: sun/moon az/el at a known Taipei datetime vs reference
  values (tolerance 0.1°).

## v2 parking lot

- Multi-day band overlay ("which date puts the spot on this road")
- Preset structures (Taipei 101, fuji, skytree…)
- AR camera overlay (would motivate Capacitor wrap)
- Spot sharing via URL params
