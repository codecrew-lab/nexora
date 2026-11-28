# NEXORA reader enclosure

A two-part 3D-printable box for the reader in [`../nexora_rfid_reader`](../nexora_rfid_reader).

| File | What it is |
| --- | --- |
| `nexora_reader_base.stl` | Base, ready to print |
| `nexora_reader_lid.stl` | Lid, already turned face down for printing |
| `nexora_reader_enclosure.scad` | OpenSCAD source; every size is a setting at the top |

**Size:** 114.8 × 68.8 × 34 mm closed. Inside space is 110 × 64 × 30 mm.

## What goes where

- **RC522** sits in a frame under the lid, below the engraved contactless symbol. Cards read through the 2 mm lid.
- **OLED** sits in a frame behind a 25 × 14 mm window. Its header faces the back edge.
- **Buzzer** (12 mm, passive) sits in a ring under the 7-hole grille.
- **ESP32 DevKit V1** sits on four corner posts 15 mm above the floor, with its USB port toward the right-hand wall opening.
- **Wall mount:** two keyhole slots, 60 mm apart, for screws with heads up to 7.5 mm.

## Print

PLA or PETG, 0.2 mm layers, 3 perimeters, 20 % infill, no supports. Print the lid face down, as it is in the STL.

## Assemble

1. Wire everything, following the diagram in the reader README.
2. Press the RC522, OLED and buzzer into their frames under the lid. Add a drop of hot glue if they're loose.
3. Set the ESP32 on its posts, with the USB end at the side opening.
4. Close the lid with 4 × M3 × 8 mm flat-head screws.

## Change the design

Open the `.scad` file in [OpenSCAD](https://openscad.org) and edit the settings at the top, for example `rc522`, `oled` or `esp_lift` if your modules differ. Choose `part = "base"` or `"lid"`, render with F6, then use File → Export → STL. Set `part = "assembly"` to see everything in place.

The lid carries a geometric tap symbol, so the STL needs no fonts. To add text under the screen, set `label_text = "NEXORA"`. This needs desktop OpenSCAD with fonts installed.
