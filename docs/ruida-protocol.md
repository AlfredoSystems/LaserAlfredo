# Ruida protocol notes (`.rd` files, RDC6442G/S)

Status: **written from public documentation and from RDWorks sample files. Nothing here has been run on our machine.** No `.rd` file exported by LightBurn or RDWorks for this machine was available. Read "Unverified / needs a machine test" before running any file this driver writes.

Code: `src/drivers/ruida/` (`swizzle.ts`, `encode.ts`, `job.ts`, `describe.ts`). Golden files: `tests/fixtures/ruida/`.

## 1. Sources

| # | Source | Licence / status | How it was used |
|---|--------|------------------|-----------------|
| S1 | EduTech Wiki, "Ruida": https://edutechwiki.unige.ch/en/Ruida | No licence statement found on the page itself (not confirmed). | Documentation: scramble, data types, command table, two annotated example files. |
| S2 | Stefan Schuermans, "Reverse Engineering of Laser Cutter Controller RDLxxx and RDCAM Software": https://stefan.schuermans.info/rdcam/scrambling.html , https://stefan.schuermans.info/rdcam/messages.html , https://stefan.schuermans.info/rdcam/pc_conn.html | No licence stated. Disclaimer: "educational purposes only", no warranty. | Documentation: scramble steps (lists RDC6442G with magic 0x88), value layouts and their limits, move/cut/power messages. |
| S3 | jnweiger/ruida-laser: https://github.com/jnweiger/ruida-laser | **GPL-2.0.** | Only `doc/protocol.md`, `example-files/laser_percentages/README.txt` + `codes.txt`, and the RDWorks-exported sample files `example-files/square_tri_test_rdworks.rd`, `percent-1-32.rd`, `percent-69-100.rd`, `Hart.rd` were read. The sample files were unscrambled locally to observe what RDWorks writes. **No source code from this repository was read or copied, and none of its files are in this repo.** |
| S4 | MeerK40t, `meerk40t/ruida/rdjob.py`: https://github.com/meerk40t/meerk40t | **MIT.** | Behavioural reference: command names, the meaning of `D8 10/11/12`, and which commands its own writer emits. No code copied (so no `THIRD_PARTY.md` entry was needed). |
| S5 | LightBurn forum / docs on device origin: https://forum.lightburnsoftware.com/t/move-lightburn-origin-zero-to-different-corner-than-machines-absolute-zero/174551 , https://docs.lightburnsoftware.com/CoordinatesOrigin | Forum posts / vendor docs. | Only search-result summaries were read, not the full pages. Used for the origin section. |

S3's sample files are the strongest evidence here: they are real RDWorks output for an RDC6442G-class controller (Thunderlaser Nova35). S1's examples look like real files from a different software version. Where S1 and S3 differ it is noted below.

## 2. Scrambling ("swizzle")

Every byte of the file is scrambled on its own (S1, S2, S4 agree):

1. swap bit 0 and bit 7,
2. XOR with the model's magic byte,
3. add 1 modulo 256.

Unscrambling reverses the steps. The magic byte is **0x88** for RDC644xG/S (S1 lists 644XG and 644XS; S2 lists RDC6442G). Other models use other values (S1 has a table by card ID).

Checks: plain `00` → `89`. RDWorks files start with plain `D8 12 F0` and end with `D7`; on disk the sample files start `D2 9B FA` and end `60`, which the implementation reproduces.

An `.rd` file is nothing but the scrambled command stream. There is no file header, length field or checksum in the RDWorks sample files. (The 2-byte checksum and ACK byte belong to the UDP link and are not part of a file.)

## 3. Values

A byte with the top bit set starts a command; every following parameter byte is `00`–`7F`. Numbers are therefore groups of 7 bits, most significant group first.

| Type | Bytes | Meaning | Evidence |
|------|-------|---------|----------|
| Absolute coordinate | 5 | Signed 35-bit two's complement, micrometres | S1, S2, S3. 50 mm = `00 00 03 06 50`; -50 mm = `7F 7F 7C 79 30` (S3 file); -1 µm = `7F 7F 7F 7F 7F` (S2). |
| Relative coordinate | 2 | Signed 14-bit two's complement, micrometres, ±8.19 mm | S1, S2, S3. +4 mm = `1F 20`, -4 mm = `60 60` (S3 file). Decoded by the disassembler, never written by the driver. |
| Power | 2 | 0…0x3FFF = 0…100 % | S1, S2, S3. The S3 percentage table fixes the rounding: value = floor(pct × 16383 / 100), e.g. 1 % = `01 23`, 30 % = `26 32`, 50 % = `3F 7F`, 69 % = `58 28`. |
| Speed | 5 | Unsigned, micrometres per second | S1, S2, S3. 100 mm/s = `00 00 06 0D 20`. |
| Time | 5 | Microseconds (S1) | Only ever written as 0. |
| Colour | 5 | blue << 16 \| green << 8 \| red | S1, S2, S3. Red = `00 00 00 01 7F`, blue = `00 07 7C 00 00`. |
| Layer index ("part") | 1 | 0…127 | S1, S2. |

The driver rounds coordinates to the nearest micrometre and rounds power **down**.

## 4. File skeleton written by `buildRuidaCommands`

The sequence is the one RDWorks writes for a vector cut job (S3 files, S1 examples), with three deliberate differences listed in 4.5. `<min>`/`<max>` are two absolute coordinates (X then Y). `i` is the layer index.

### 4.1 Preamble and job bounding box

| Bytes | Name (S1/S4) | Notes |
|-------|--------------|-------|
| `D8 10` | Ref point mode 2 | "Machine zero / absolute position" (S4). S3 files use `D8 12` (current position), S1's examples use `D8 10`. |
| `F0` | Ref point set | |
| `E6 01` | Set absolute | Present in S1's examples and S4's writer, absent in S3 files (which are not absolute). |
| `F1 02 00` | Enable block cutting 0 | |
| `D8 00` | Start process | |
| `E7 06 <0> <0>` | Feed repeat | |
| `E7 03 <min>` | Process top-left | Minimum X/Y of all cut points. |
| `E7 07 <max>` | Process bottom-right | Maximum X/Y. |
| `E7 50 <min>` | Document min point | |
| `E7 51 <max>` | Document max point | |
| `E7 04 00 01 00 01 <0> <0>` | Process repeat | 1 × 1. |
| `E7 05 00` | Array direction | |

### 4.2 Layer table (once per layer)

| Bytes | Name | Notes |
|-------|------|-------|
| `C9 04 i <speed>` | Layer speed | |
| `C6 31 i <power>` | Laser 1 min power | |
| `C6 32 i <power>` | Laser 1 max power | |
| `C6 41 i`, `C6 42 i`, `C6 35 i`, `C6 36 i`, `C6 37 i`, `C6 38 i` + `<power>` | Laser 2 min/max, laser 3 min/max, laser 4 min/max | Always present in RDWorks files. Written as **0 %**, see 4.5. |
| `CA 06 i <colour>` | Layer colour | |
| `CA 41 i 00` | Layer work mode | 0 in every vector file seen. |
| `E7 52 i <min>`, `E7 53 i <max>` | Layer min / max point | Bounding box of the layer. |
| `E7 61 i <min>`, `E7 62 i <max>` | Layer min / max point "ex" | Same values in every file seen. |

Then `CA 22 n` where n is the highest layer index.

### 4.3 Offsets, element and array blocks

Constant apart from the bounding box. Meaning of most of it is unknown; the bytes are copied from what RDWorks writes for a single, non-arrayed job.

`E7 54 00 <0>`, `E7 54 01 <0>` (pen offset), `E7 55 00 <0>`, `E7 55 01 <0>` (layer offset), `F1 03 <0> <0>` (display offset), `F1 00 00`, `F1 01 00`, `F2 00 00`, `F2 01 00`, `F2 02 05 2A 39 1C 41 04 6A 15 08 20` (element name, identical in every file from S1 and S3), `F2 03 <min>`, `F2 04 <max>`, `F2 06 <0> <0>`, `F2 07 00`, `F2 05 00 01 00 01 <width> <height>`, `EA 00` (array start), `E7 60 00`, `E7 13 <min>`, `E7 17 <max>`, `E7 23 <0> <0>`, `E7 24 00`, `E7 08 00 01 00 01 <width> <height>`.

### 4.4 Layer bodies and trailer

Per layer, in job order:

| Bytes | Name | Notes |
|-------|------|-------|
| `CA 01 00` | "End Layer" (S1) | Despite the name it comes first in every layer block. |
| `CA 02 i` | Layer number | Selects the layer. |
| `CA 01 30` | Laser 2 offset off | |
| `CA 01 10` | Layer device 0 | |
| `CA 01 13` | Air assist on | In every file seen. |
| `C9 02 <speed>` | Speed | |
| `C6 12 <0>`, `C6 13 <0>` | Laser on / off delay | S3 and S4. S1's examples use `C6 15` / `C6 16` instead. |
| `C6 01 <power>`, `C6 02 <power>` | Laser 1 min / max power | |
| `C6 21`, `C6 22`, `C6 05`, `C6 06`, `C6 07`, `C6 08` + `<power>` | Lasers 2–4 min/max | 0 %. |
| `CA 03 0F` | Laser tube enable | `0F` in S3 files, `0D` in S1's examples, `01` in S4's writer. Meaning unknown. |
| `CA 10 00` | Ext IO enable | |
| `88 <x> <y>` | Move absolute, laser off | To the first point of each path. |
| `A8 <x> <y>` | Cut absolute, laser on | To every further point. A closed path ends with a cut back to its first point. |

Passes: the layer's whole move/cut list is written `passes` times inside the one layer block.

Trailer: `EB` (array end), `E7 00` (block end), `DA 01 06 20 <v> <v>`, `D7` (end of file). `<v>` is a 5-byte unsigned number written twice, see 4.5.

### 4.5 Where the driver deliberately differs from the RDWorks samples

1. **`D8 10` + `E6 01` instead of `D8 12`.** Our `Job` is in absolute bed coordinates, so the file uses absolute mode. All S3 samples are "current position" files.
2. **Lasers 2–4 are written as 0 %.** RDWorks writes whatever its dialog holds for them. The HL1060 has one tube on laser 1; zero is the safe value for outputs that should never fire.
3. **Through power (`C6 50/51/55/56`) is not written.** S3 files always write 50 % there; S1's examples and S4's writer leave it out. Leaving it out keeps a power value that ignores the cap out of the file.

Also: `<v>` in `DA 01 06 20` is written as the total cut length in whole millimetres (rounded down, all passes). In S1's two examples the value equals exactly that (327 and 690). In the S3 files it is close to, but not the same as, any length I could compute (e.g. 330 for a file with 304.5 mm of cuts and 21.3 mm of travel). The true definition is unknown.

### 4.6 Things the driver never writes

Relative moves/cuts, raster/engrave modes, arrays, feed, Z/U axes, any other `DA` parameter write, filename (`E7 01`), travel speed. **`travelSpeedMmS` is accepted and validated but not written**: none of the sources shows a file command for it; the controller uses its own "idle speed" setting (S1 default table: 200 mm/s).

## 5. Coordinates and origin

- Job coordinates are mm, origin top-left, Y down. File coordinates are µm measured from the controller's machine zero.
- A Ruida controller puts machine zero in the corner where it homes (S5). Positive X and Y run away from that corner. Many machines of this class home to the **rear right**, some to the rear left (S5); which one the HL1060 uses is not known yet.
- All axis flipping is in one function, `jobPointToMachineUm(point, bed, origin)`, driven by `RuidaOptions.origin`:
  - `top-left` (default, per CLAUDE.md): X and Y unchanged.
  - `top-right`: X = bed width − x.
  - `bottom-left`: Y = bed height − y.
  - `bottom-right`: both.
- Bounding boxes are computed after the flip, so "min" is always the numerically smaller corner.
- The bed check is done on the job coordinates before the flip. A flipped file still lies inside 0…width × 0…height, so a wrong `origin` gives a mirrored cut inside the bed, not a crash into a rail. That assumes the controller's travel really is 1000 × 600 mm from its home corner.

## 6. Safety rules enforced in the driver

`buildRuidaCommands` throws `RuidaJobError` (it never clips or repairs) for: non-finite or out-of-bed coordinates (tolerance 1e-6 mm), an empty job, a path with fewer than two distinct points, speed that is non-finite, ≤ 0, below 1 µm/s or above `RUIDA_MAX_SPEED_MM_S` (500 mm/s, a driver limit, not a protocol limit), non-finite power or power cap, passes that are not a whole number in 1…100, a colour not in `#rrggbb` form, more than 128 non-empty layers, an invalid bed or magic byte.

Power: clamped to 0–100 %, then to `maxPowerCapPct` (itself clamped to 0–100 %), then min is lowered to max if it was higher. Every power field in the file goes through this or is the constant 0.

Layers with no paths are left out. Consecutive identical points (after rounding to µm) are merged so no zero-length cut is written. `Job.bounds` is ignored; bounds are recomputed from the points.

## 7. Golden files

`tests/fixtures/ruida/<name>.rd` is the exact file; `<name>.txt` is the output of `describeRuidaCommands` on its unscrambled stream. `src/drivers/ruida/golden.test.ts` regenerates each job and compares byte for byte.

**These files prove that the output is stable and follows the format described here. They do not prove that a controller accepts or correctly runs them.** None comes from RDWorks, LightBurn or a machine.

Regenerate on purpose only, after an intended encoding change, and review the `.txt` diff:

```
# PowerShell
$env:UPDATE_GOLDEN = '1'; pnpm vitest run src/drivers/ruida/golden.test.ts; Remove-Item Env:UPDATE_GOLDEN
# POSIX sh
UPDATE_GOLDEN=1 pnpm vitest run src/drivers/ruida/golden.test.ts
```

Cross-check done once, by hand: the disassembler decodes the four S3 sample files (26 857 commands) with no unknown or malformed command, and the command sequence of `rectangle-50x30.txt` matches `square_tri_test_rdworks.rd` except for the three differences in 4.5.

## 8. Unverified / needs a machine test

Confidence is about "an RDC6442 will accept this and do what the description says".

| # | Assumption | Confidence | Why |
|---|------------|------------|-----|
| 1 | Scramble with magic 0x88 | High | Three sources agree; reproduces real file bytes. Wrong magic = controller shows no or a broken file. |
| 2 | Coordinate, power, speed, colour encodings | High | Sources agree and match real file bytes. |
| 3 | `88` move / `A8` cut absolute | High | S1, S2, S3 agree. |
| 4 | Overall command order of the file | Medium–high | Copies RDWorks output, but see 5–9. |
| 5 | `D8 10` + `F0` + `E6 01` makes the coordinates absolute machine coordinates, ignoring the panel's origin | **Medium** | From S1's example and S4. No absolute-mode file from RDWorks/LightBurn was available. If wrong, the job could run relative to the head position or panel origin instead. |
| 6 | Machine zero corner and axis directions (`origin` option, default `top-left`) | **Low** | Not known for this machine. Rear right is common, which would need `origin: 'top-right'`. Wrong value = mirrored cut. |
| 7 | Lasers 2–4 at 0 % is harmless and laser 1 is the tube | Medium | If the tube were wired to the laser 2 output, nothing would fire. |
| 8 | Leaving out through power (`C6 50…`) is fine | Medium | S1 examples and S4 leave it out; S3 always writes it. |
| 9 | `CA 03 0F`, `CA 10 00`, the element/array block and its width/height values | Medium | Copied from RDWorks files without knowing the meaning. RDWorks writes varying signs for the two size values; the driver writes both positive. |
| 10 | `DA 01 06 20 <v> <v>` with v = cut length in mm | **Low** (meaning), medium (harmless) | Present in every real file, so it is written; its exact definition is unknown. It looks like a statistic. |
| 11 | Multiple passes by repeating the geometry inside one layer block | Medium | Nothing in the format forbids it, but no sample shows it. |
| 12 | `C6 12/13` (not `C6 15/16`) for the zero on/off delays | Medium | S3 + S4 against S1. |
| 13 | Travel speed comes from the controller, no file command needed | Medium | No sample contains one. |
| 14 | Air assist on (`CA 01 13`) switches the air output if the machine has one wired | Medium | Name from S1/S4 only. |
| 15 | Power 0 % means the tube does not fire | Medium | Depends on the laser power supply, not the file. Do not rely on it for a dry run. |
| 16 | The controller reads the file from a FAT32 stick with a short plain name | Medium | Forum reports of name/extension limits; keep names short, lowercase, `.rd`. |

### Safe verification procedure

Do these in order. Stop at the first surprise and compare with section 4.

1. **Compare with a real export first (no machine needed).** In LightBurn (or RDWorks) draw a 50 × 30 mm rectangle at the same place, same speed and power, "Absolute Coords", and save the `.rd`. Unscramble and list it with `describeRuidaCommands(unswizzle(bytes, 0x88))` and diff it against `tests/fixtures/ruida/rectangle-50x30.txt`. This settles most of rows 4–12 at once, and the X values show which `origin` LightBurn's device setting corresponds to. Keep that file as a real golden fixture.
2. **Make the laser unable to fire.** Tube power supply off or its enable/interlock open (lid open if the lid switch is wired, water protect unplugged). Do not rely on a low power value.
3. **Export with `maxPowerCapPct: 1`** anyway, a small job (the 50 × 30 rectangle at (10, 10)), copy it to a stick, and load it on the panel.
4. **Look at the panel preview.** The outline and layer speed/power shown should match. A missing or garbled preview means rows 1, 4 or 9 are wrong: do not start.
5. **Press "Frame" (box) with a hand on the stop button.** Watch where the head goes. It should trace a 50 × 30 mm box 10 mm from the home-side edges. This tests rows 5 and 6. If the box is mirrored, change `origin`. If it starts from wherever the head was, row 5 is wrong.
6. **Dry run with the laser still disabled.** Start the job and watch the path, the number of passes on a two-pass file, and that it stops at the end.
7. **First burn.** Scrap sheet, lid closed, extraction and air on, `maxPowerCapPct` at 10–15 %, slow speed. Check size with callipers (50.0 × 30.0 mm), that the shape closes, and that corners are not overburnt (min power).
8. Only then raise the cap. Record what was learned here and move rows out of this table.

## 9. USB link (for milestone 3, not used by this driver)

Leads only, nothing verified: S1/S2 say the controller's USB port is an FT245R presenting a serial port at 19200 baud, 8N1, hardware flow control, carrying the same scrambled commands as the files. The 2-byte checksum and per-packet ACK are described for UDP only.
