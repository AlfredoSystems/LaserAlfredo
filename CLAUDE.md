# CLAUDE.md

## Project
Browser-based laser control software for a HL1060 CO2 laser (1000 × 600 mm bed). It replaces the LightBurn features I actually use and adds built-in DXF nesting. Single user and a single machine. Local-first: it runs on my LAN and doesn't need accounts or a cloud backend.

**Stage:** greenfield. Build in the milestone order under Roadmap. Don't build ahead.

## Hardware assumptions (verify before writing driver code)
- Controller: **Ruida** (assumed; most 1060s ship with an RDC644x/6445). Check the actual model on the controller panel and put it here: `[RDC____]`.
- Connection: **USB** (confirmed). Not Ethernet, so nothing in this project uses UDP. The controller is expected to appear on the PC as a virtual COM port (serial over USB).
- Fallback: export a `.rd` file and run it from a USB stick or the controller's file upload. This needs no live connection and should be supported from day one.
- Ruida protocol: commands are byte-scrambled (swizzle with the model's magic byte, 0x88 on 644x). Treat open-source Ruida implementations (e.g. MeerK40t's Ruida driver) as references only. Don't copy GPL code into this repo.
- **Unverified for USB:** the 2-byte packet checksum and the per-packet ACK (0xC6) are documented for the UDP link. Whether the USB serial link uses the same framing, plus its baud rate and flow control, must be confirmed with a dry-run experiment in milestone 3 before any live-control code is written.
- Transport choice (decide in milestone 3): Web Serial straight from Chrome/Edge (no bridge needed), or the Node bridge with `serialport`.

## Stack
- TypeScript (strict), Vite, React
- State: Zustand
- Canvas: 2D canvas with my own scene graph (no SVG DOM per shape, since it's too slow on large DXFs)
- Geometry: `clipper2` (offsets and booleans) and `dxf-parser` (DXF import)
- Heavy work (nesting, toolpath generation, raster dithering) runs in Web Workers via Comlink
- Bridge (only if Web Serial isn't used): Node 22 with `ws` and `serialport`, under 200 lines, with no business logic
- Tests: Vitest (unit) and Playwright (UI smoke)
- Package manager: pnpm. Never use npm or yarn.

## Commands
- Install: `pnpm install`
- Dev (app): `pnpm dev`
- Dev (bridge): `pnpm bridge`. Add `--dry-run` to log packets without sending them. (Arrives in milestone 3.)
- Test all: `pnpm test`
- Test one file: `pnpm vitest run path/to/file.test.ts`
- Lint and typecheck: `pnpm lint && pnpm typecheck`
- Build: `pnpm build`

## Layout
- `src/model/`: document model (shapes, layers, units). Pure TS, no React.
- `src/import/`: DXF and SVG importers that produce model shapes
- `src/geometry/`: offsets, path joining, inside-first ordering, bounding boxes
- `src/nesting/`: nesting engine (runs in a worker)
- `src/toolpath/`: model → machine-agnostic job (moves, cuts, power, speed)
- `src/drivers/ruida/`: job → Ruida bytes (encoder, swizzle, checksum, `.rd` writer)
- `src/transport/`: `Transport` interface with `FileExport` and `SerialTransport` (USB serial) implementations
- `src/ui/`: React components, kept thin. Logic lives in `model/`, `geometry/` and `toolpath/`.
- `bridge/`: local WebSocket ↔ USB serial relay
- `tests/fixtures/`: sample DXFs (including messy real-world ones) and golden `.rd` byte files

## Domain rules
- Internal units are **millimetres** as floats. Convert only at import (DXF `$INSUNITS`) and in the driver.
- Coordinate system: origin at top-left, Y increasing downward, to match the Ruida default. Isolate any flip in one function.
- Layers are keyed by color, as in LightBurn. Each layer has mode (line/fill), speed (mm/s), max power %, min power %, passes, and an enabled flag.
- Cut order: inner contours before outer ones (so parts don't drop before their holes are cut), then minimize travel.
- Kerf compensation goes through clipper2 offsets: outward for outer contours, inward for holes.
- DXF import must handle LINE, LWPOLYLINE (with bulges), POLYLINE, ARC, CIRCLE, SPLINE, ELLIPSE and INSERT/blocks. It must join near-coincident endpoints (tolerance configurable, default 0.01 mm) into closed paths.

## Safety (non-negotiable)
- Code and tests must never send a job or fire command to real hardware. Tests use the dry-run transport or a fake serial port.
- Clamp power to 0–100% in the driver regardless of what the UI sends, and enforce a configurable max power cap.
- Every job is checked against the bed bounds (1000 × 600 mm) before sending. Out-of-bounds means refusing the job, never clipping it.
- Stop and pause must work at any point and must not wait behind queued packets.
- Don't change byte encoding in `src/drivers/ruida/` without a golden-file test that proves the output.

## Roadmap (build in this order)
1. **Import and view:** DXF/SVG import, pan and zoom, select, move, scale, rotate, layers panel.
2. **Job output:** toolpath generation, cut ordering, kerf offset, time estimate, preview, `.rd` file export.
3. **Live control:** bridge, connect/status, jog, set origin, frame, start/pause/stop.
4. **Nesting:** pick a sheet size and part quantities, then nest. Parts can rotate in configurable steps. Spacing, sheet margins and use of holes are configurable. Results show utilization %. Use the no-fit-polygon approach with a genetic algorithm (the SVGnest/Deepnest style) in a worker that streams progressively better results.
5. **Engraving:** fill/scanline for vector shapes, then image raster (grayscale, dithering, overscan).
6. **Nice to have:** material library, saved projects (IndexedDB), job history.

Out of scope unless I ask: camera alignment, rotary, galvo, print-and-cut, text/font editing beyond basic text, other controller brands.

## Workflow
- Propose a short plan before any task that touches more than one directory, and wait for approval.
- Work in small steps. After each change, run only the relevant test file.
- Before calling a task done, lint, typecheck and tests must pass.
- Geometry, nesting and driver code need unit tests. The driver needs golden-file tests.
- Never delete or weaken a failing test to get it to pass.
- When unsure about Ruida behavior, say so and suggest a dry-run experiment instead of guessing.

## Code conventions
- Named exports only.
- Keep pure functions in `model/`, `geometry/`, `toolpath/` and `drivers/`. No DOM or React imports there.
- Worker APIs are typed through Comlink and take and return plain data (no class instances).
- No `any`. Use `unknown` and narrow it.
- Match the style of surrounding code.

## Do not
- Add dependencies without asking.
- Copy code from GPL-licensed projects. MIT/BSD/Apache code is fine with attribution in `THIRD_PARTY.md`.
- Put machine I/O anywhere except `src/transport/` and `bridge/`.
- Commit large binary fixtures (over 1 MB) without asking.

## Git
- One branch per task: `feat/…`, `fix/…`, `chore/…`
- Conventional Commits
- Never commit directly to `main`

## Gotchas
<!-- Add to this as problems come up. -->
- Many DXFs from CAD tools contain tiny gaps, duplicate overlapping lines and splines. Expect messy input.

## More context
- Ruida protocol notes: `docs/ruida-protocol.md`. Write this as reverse-engineering findings come in.
- Nesting design: `docs/nesting.md`
