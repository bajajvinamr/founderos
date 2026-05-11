// W2.3: this file is a compat shim. The legacy /routines route in App.tsx
// (which W2.3 is not allowed to edit) lazy-imports `Routines` from this path.
// The real page now lives at `./work/Cadences.tsx` and is named Cadences.
//
// I2 (the route-wiring agent) will:
//   1. Add `/work/cadences` to App.tsx mounting `Cadences` directly.
//   2. Convert `/routines` into a 302 → `/work/cadences` redirect.
//   3. Delete this shim file.
//
// Until then, mounting `/routines` renders the same Cadences component so the
// URL works and the rename is founder-visible everywhere on the page.

export { Cadences as Routines } from "./work/Cadences";
