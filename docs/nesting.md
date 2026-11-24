# Nesting engine

Design notes for `src/nesting/`. The engine packs arbitrary polygons onto one
or more sheets, toward x = 0, so the leftover is one rectangle on the right.

| File | Job |
| --- | --- |
| `types.ts`, `placement.ts` | The contract with the UI (not engine code). |
| `prepare.ts` | Parts → integer "nest polygons" per rotation; no-fit region cache. |
| `nfp.ts` | No-fit regions from Minkowski sums (convolution cycles). |
| `layout.ts` | One layout: place the copies in a given order. |
| `search.ts` | Which order, rotations and scoring rule to try next. |
| `engine.ts` | `createNester`: one layout per `step()`, fitness, results. |
| `testing.ts` | Shape builders and an independent layout checker for the tests. |

Everything is deterministic for a given input and seed (`rng.ts`, mulberry32).
No `Math.random`, no clock.

## Coordinates

Geometry is done by `clipper2-ts` on integers. One unit is 0.0001 mm for jobs
up to 3 m across, 0.001 mm up to 30 m, and so on (`Prepared.scale`), which
keeps clipper's products inside doubles. Each part is worked on near the
origin wherever it sits in the document.

## Preparing a part

For every allowed rotation (multiples of `rotationStepDeg` in [0, 360); only 0
when the step is 0 or the part may not rotate; at most 72, a finer step is
thinned to every k-th multiple):

1. Rotate the true outline in floating point, round to the grid.
2. Simplify with Ramer–Douglas–Peucker at 0.1 mm. The simplifier reports the
   deviation it actually caused (0 for a rectangle).
3. Grow by `spacing / 2 + deviation` (+1 unit if rounding moved a vertex) with
   mitred corners. The result, the **nest polygon**, always contains the true
   part grown by half the spacing, so two nest polygons that do not overlap
   keep the true parts at least `spacingMm` apart.
4. Holes (only with `useHoles`) are shrunk by the same amount and cut out of
   the nest polygon. Holes that vanish are dropped; a hole that would cut the
   part in two is ignored.
5. Open outlines, and closed ones without area, become a thin strip (at least
   0.01 mm half-width) around the path.
6. The polygon is moved so that its lowest (x, then y) outer vertex, the
   **reference vertex**, is the origin. Polygons that are then identical share
   one id, so congruent parts share their no-fit regions, and a rotation that
   reproduces an earlier polygon (a square at 90°) is dropped.

Rotations that differ by a quarter turn are derived by turning the integer
polygon exactly, not by preparing again.

Outlines with more than 120 vertices after step 2 are simplified further (the
tolerance doubles, up to 1.6 mm). They nest slightly looser but stay fast.

The sheet margin is tested on the **true** bounding box, not on the grown
polygon: a part can sit exactly `marginMm` from the edge, also when half the
spacing is wider than the margin. A rotation that does not fit an empty sheet
is dropped; a part with no rotation left is reported in `unplaced` with its
full count.

## No-fit regions

For a fixed polygon A and a moving polygon B, the no-fit region is every
position of B's reference vertex at which B overlaps A: the Minkowski sum
A ⊕ (−B). Its outline is the classic no-fit polygon.

### Convolution cycles, not a boundary sweep

The textbook construction with clipper sweeps one boundary along the other
(n·m quads) and unions them. Two problems:

- **It is wrong on its own.** The sweep only covers positions where the
  boundaries cross. Unioning with A (the first design for this engine) repairs
  the case "B entirely inside A", but not "A entirely inside B", which leaves
  a false hole whenever the moving part is bigger than the fixed one. The
  complete rule is:
  two connected regions overlap iff their boundaries cross, or a vertex of B is
  in A, or a vertex of A is in B. `sweepSumRegion` implements exactly that and
  is kept as the fallback and as the reference in the tests.
- **It is slow.** 40 × 40 vertices took about 60 ms.

`convolutionCycles` instead traces the convolution of the two outlines (Guibas,
Ramshaw, Stolfi 1983; Wein 2006): the segments `edge of A + vertex of B` for
which the edge's direction lies inside the turn B makes at that vertex, and
the same with A and B swapped. A segment carried by a right-turn (reflex)
vertex runs backwards. These segments close into cycles whose winding number
at t is the number of connected pieces of A ∩ (B + t), so a non-zero union of
the cycles is the Minkowski sum. For ordinary parts the number of segments is
close to n + m. Measured: two 100-vertex crescents take under 1 ms (the sweep
needs 10 000 quads); spiky stars remain the worst case (40 × 40 points: 8 ms).

Parallel edges are tie-broken as if B were rotated by a vanishing angle, which
keeps the cycles closed; the tests run 400 random pairs, a third of them
rectilinear, against the sweep.

Regions that stay empty inside the sum are genuine: B fits into an enclosed
concavity of A there.

### Holes

Holes are not part of the outline convolution, because the winding number then
counts pieces minus holes of the overlap and can cancel to zero. Instead the
positions that put B entirely inside a hole of A are computed separately and
cut out of the region (`insideFitRegion`): the hole ring, walked as the
boundary of its complement, is convolved with −B, and the answer is the
region of winding number −1 (0 means B pokes out once, more means several
times). The same is done for A inside a hole of B, mirrored. A bounding-box
test skips holes the other part cannot fit.

### Exact fits and the tolerance

A slot exactly as wide as the part is a region without area, and polygon
clipping loses it. So the fixed polygon is shrunk by `FIT_EPS` = 2 units
(0.2 µm at the usual scale) before the sum, holes are widened by the same,
and the sheet's free rectangle is widened too. Exact fits then survive as
slivers a few units wide.

The price is that a corner of the free region may sit up to about two units
per axis inside a neighbour. `snap` (in `layout.ts`) repairs that: it moves
the chosen corner to the best grid position within reach that the **exact**
no-fit regions allow (touching is allowed, overlap is not). Only when no such
position exists — the fit truly depends on the tolerance, e.g. a rounded,
rotated part in a slot 0.1 µm too narrow — is the loose corner kept.

**Guarantee:** parts are never closer than `spacingMm − 0.001 mm` (ten times
that for jobs between 3 m and 30 m across, where a unit is 0.001 mm), and in
the ordinary case the gap is exact. The independent checker in the tests enforces
this bound on every layout the tests produce.

### Cache

Regions are computed once per pair of base polygons and stored as packed
integer arrays. Every other pair is derived on the fly:

- turning both polygons by k quarter turns turns the region
  (N(RₖA, RₖB) = Rₖ N(A, B)), so only "A unturned" pairs are computed;
- N(B, A) = −N(A, B).

With 90° steps that is about an eighth of the pairs. Both the loosened and
the exact region are cached (the exact one only where `snap` asks).

## One layout

`buildLayout` places the copies in the order given by the search. For a copy
and a sheet:

1. Free positions = the rectangle of reference-vertex positions that keep the
   true part inside the margin, minus the no-fit regions of every part already
   on the sheet. This is kept per (sheet, rotation) and only cut by the parts
   placed since it was last used, so placing the k-th part does not redo k
   subtractions.
2. Candidates are the corners of the free positions; the best by the scoring
   rule wins. A rotation gene of −1 ("auto") tries every rotation and keeps
   the best.
3. Sheets are tried first to last; a new sheet is opened when none has room.
   Sheets whose uncovered area is smaller than the part, and (sheet, rotation)
   pairs that once had no room, are skipped.

Scoring rules (`OBJECTIVES`); the search picks one per layout:

| Rule | Order of preference |
| --- | --- |
| `length` | least growth of the used length, then left-most, then top-most |
| `gravity` | least growth of the used length, then centroid left-most |
| `center` | centroid left-most, then top-most |
| `sum` | least growth of 2 × used length + used height |

Measured on six test jobs, none of them wins everywhere: `length`/`gravity`
are best for rectangles, `center` for irregular parts. Two more were tried and
dropped: bounding-box area (sometimes strings parts along the top edge) and
plain left-most reference point (never best).

Hole filling needs nothing extra: a pocket is a piece of free region far to
the left, which every rule likes.

## Search

`search.ts` is a steady-state genetic algorithm over (order of the copies,
rotation per copy, scoring rule). One proposal per `step()`:

1. Step 1: largest area first, every part at its first rotation — the cheapest
   layout, so the UI has something at once.
2. Step 2 onward: the same order with all rotations on auto, once per scoring
   rule; then orders by longest side, height and width.
3. Then children of a population of 16: a tournament-selected parent with one
   or more mutations (swap, move, reverse a run, change a rotation, change the
   rule, or move one of the copies that set the used length to an earlier
   place), or an order crossover of two parents. Already-tried genomes are
   skipped (identical copies are interchangeable).

Small search spaces (up to 3000 distinct genomes) are walked completely, after
which `done` is true. `done` also becomes true when a layout has no waste at
all. Otherwise the search runs until the UI stops it. Several workers with
different seeds ("islands") share the opening layouts and diverge after them.

## Fitness

Lower is better:

```
unplaced copies × 1e9  +  sheets × 1e4  +  (used length of last sheet / sheet width) × 1e3
  +  mean right edge of the parts on the last sheet / sheet width      (tiebreak, 0–1)
```

`utilization` is the outline area of the placed parts (open paths count 0)
over the material used: full sheets before the last, plus the last sheet up to
its used length. `usedLengthMm` is the right-most x of the true geometry.

## Tests

- `nfp.test.ts`: convolution against the brute-force sweep, inside-fit regions
  against brute force, no-fit regions against direct overlap tests at sampled
  offsets (with holes, both ways round), exact-fit slots.
- `prepare.test.ts`: the nest polygon contains the true part grown by half the
  spacing at every rotation; rotation and congruence sharing; the quarter-turn
  algebra of the cache against brute force for all 64 pairs of two parts.
- `engine.test.ts`: every result of every test goes through `validateNest`,
  which re-measures the true outlines with `placementMatrix`: inside the
  margin, pairwise gap ≥ spacing − 0.001 mm (parts in holes allowed), every
  copy placed once or reported, allowed rotations, used length. Plus
  determinism, strict improvement, exhaustion, quality and speed.
- `testing.test.ts`: the checker itself rejects broken layouts.

## Measured performance

Node 24 on the development PC, one thread, default options (1000 × 600 mm,
90° steps, holes on), mixed parts of about 40 vertices (blobs with a concave
bite, rounded rectangles with a hole, filleted brackets, circles, rectangles):

| Job | First layout | Per layout after that |
| --- | --- | --- |
| 20 copies of 4 shapes | 24 ms | 4 ms |
| 60 copies of 12 shapes | 17 ms | 22 ms |
| 150 copies of 12 shapes (two sheets) | 20 ms | 49 ms |
| 60 copies, no rotation | 12 ms | 6 ms |
| 60 copies, 45° steps | 14 ms | 45 ms |
| 400 copies of 2 small shapes | 19 ms | 18 ms |
| 40 different parts | 0.4 s | 0.14 s |
| 100 different parts | 2 s | about 1 s while the cache fills, 0.3 s after |

Two things cost time:

- **Cutting no-fit regions out of the free positions**, about 0.1 ms per
  (part, rotation) when the sheet already knows the shape. A shape that is new
  to a sheet has to subtract every part already there, so jobs made of many
  *different* parts are quadratic in the part count; that is the 100-part row.
  Regions are cut out twelve at a time, which measured 2× faster than all at
  once (neighbouring regions overlap heavily).
- **Computing no-fit regions**, about 0.2 ms per pair (loosened plus exact)
  for 40-vertex shapes, once per pair of shape × rotation. 100 different
  parts at 90° steps have about 20 000 pairs, which is why the first layouts
  of that job are slow: the first takes 2 s and the first all-rotations
  layout 6 s.

Quality on the same kind of job: 60 mixed parts reach 78–79 % utilization of
the used length within about five seconds on one worker; 25 rectangles cut from a 400 × 600
block (100 % is possible) open at 85 % and reach 94 % after 400 layouts.

## Known limits

- **Greedy placement.** Each part goes to the best free corner and is never
  moved again; the search only changes order, rotation and rule. Interlocking
  that needs two parts placed "at once" is found only by luck of the order.
  There is no compaction or sliding pass after a layout.
- **Corners only.** Candidates are corners of the free region. For the rules
  used that loses nothing, but a rule with an interior optimum would need more.
- **Many different parts are slow** (see the table): both the number of
  no-fit regions and the work per layout grow with the square of the number
  of distinct shape × rotation combinations. Rotation is discrete, and a fine
  step multiplies that number.
- **No reuse between layouts.** A child layout that differs from its parent
  only near the end is still built from scratch.
- **Spiky outlines** (stars, gears) are the slow case for the convolution;
  detailed outlines are simplified harder (see above), which costs a little
  clearance.
- **Tolerance.** Gaps can be up to 0.001 mm under the spacing in the
  exact-fit case described above. Parts drawn off the 0.0001 mm grid get one
  extra unit of clearance instead.
- **First fit over sheets.** A later, smaller part can fill a gap on an
  earlier sheet, but parts are never moved between sheets to empty the last
  one other than through the order.
- **Self-intersecting outlines** are nested by their non-zero fill; a hole
  that crosses the outline is honoured only where it lies inside.
- Jobs wider than about 30 km at 1 mm resolution are refused (everything is
  reported unplaced).

## In the app

`src/ui/nestStore.ts` runs the search (1–4 workers with different seeds, the
lowest fitness wins) and puts the result straight into the document. There is
no preview and no apply step.

- **One undo step.** The first layout replaces the parts through
  `commitDocument`; every better layout, every sheet switch and every "Nest
  again" swaps that document through `amendDocument`, which adds no history
  entry and only works on the very document the nest put there. So one Ctrl+Z
  from a nested document always returns to the original parts, never to an
  earlier layout.
- **What the nested document is.** The document from before Nest (the
  *base*), minus the originals of every part that has a copy on any sheet,
  plus the copies of the sheet on the bed. Parts with quantity 0 and parts
  that fit no sheet keep their originals where they were.
- **Session.** From the press on Nest until something else changes the
  document. During it the panel lists the original parts, and "Nest again"
  nests those: with changed settings the next layout replaces the current one
  ("Out of date" until then), with unchanged settings it searches on with new
  seeds and only a better layout replaces it.
- **Leaving it.** Any other document change (move, delete, paste, import,
  colour, layer settings, undo) stops the search and returns the panel to its
  normal state; the sheet on the bed stays as ordinary shapes. The session is
  kept for as long as undo or redo can bring its document back, and carries
  on when they do (the search does not restart). Undoing the nest also
  restores the selection the parts were taken from.
- The search stops by itself 20 s after the last improvement, or when every
  worker has tried all layouts.
