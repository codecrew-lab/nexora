// NEXORA RFID reader enclosure
//
// A two-part box (base + screw-on lid) for the reader in hardware/nexora_rfid_reader:
//   * RC522 card reader held under the lid, under the contactless "tap here" mark
//   * 0.96" SSD1306 OLED behind a window in the lid
//   * passive buzzer under a grille in the lid
//   * ESP32 DevKit V1 on corner posts in the base, USB port through the side wall
//   * two keyhole slots in the floor for wall mounting by the classroom door
//
// Open in OpenSCAD (https://openscad.org), choose `part`, press F6, then
// File > Export > STL. Pre-rendered STLs are in this folder.
// All dimensions are in millimetres.

/* [Output] */
part = "print"; // [print, base, lid, assembly]

/* [Box] */
inner = [110, 64, 30];   // free space inside: length, depth, height
wall = 2.4;              // side walls
floor_t = 2.0;           // base floor
lid_t = 2.0;             // lid plate; the RC522 reads cards through it
corner_r = 4;            // outer corner radius
fit = 0.3;               // clearance for parts that slot together

/* [Screws] */
boss_d = 7;              // corner screw posts in the base
pilot_d = 2.5;           // pilot hole for M3 self-tapping screws
screw_d = 3.4;           // clearance hole in the lid
head_d = 6.4;            // countersink diameter for M3 flat-head screws

/* [Modules] */
rc522 = [60, 39.5];      // RC522 board
oled = [27.5, 27.8];     // SSD1306 0.96" I2C board
oled_window = [25, 14];  // visible screen opening
esp = [52, 28.5];        // ESP32 DevKit V1 (30 pin)
esp_lift = 15;           // board height above the floor, leaves room for jumpers on the header pins
buzzer_d = 12;           // passive buzzer body
usb_cut = [12, 8];       // micro-USB plug opening (width, height)

/* [Label] */
// Optional text under the screen, e.g. "NEXORA". Needs OpenSCAD with fonts.
label_text = "";

$fn = 48;

outer = [inner.x + 2 * wall, inner.y + 2 * wall];
base_h = floor_t + inner.z;

// Positions in box coordinates (origin at the outer corner, x = length, y = depth).
rc522_pos = [wall + 44, wall + (inner.y - rc522.y) / 2];
oled_pos = [wall + 9, wall + inner.y - oled.y - 9];
buzzer_c = [oled_pos.x + oled.x / 2, wall + 14];
esp_pos = [wall + inner.x - esp.x - 2, wall + (inner.y - esp.y) / 2];
usb_center = [esp_pos.y + esp.y / 2, floor_t + esp_lift + 1.6 + 1.5];  // y, z
// Corner screw posts, sunk 0.8 mm into the walls so they fuse into one solid.
boss_in = boss_d / 2 - 0.8;
bosses = [for (x = [wall + boss_in, outer.x - wall - boss_in],
               y = [wall + boss_in, outer.y - wall - boss_in]) [x, y]];

module rounded_rect(size, r) {
  offset(r = r) offset(delta = -r) square(size);
}

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------
module keyhole() {
  // Screw head (up to 7.5 mm) enters the round hole, then slides up the slot.
  cylinder(d = 8, h = floor_t + 2);
  hull() for (dy = [0, 8]) translate([0, dy, 0]) cylinder(d = 4, h = floor_t + 2);
}

module esp32_cradle() {
  t = 1.6;     // locating lip thickness
  post = 5;    // corner post size under the board
  translate([esp_pos.x - t, esp_pos.y - t, floor_t - 0.01])
    difference() {
      cube([esp.x + 2 * t, esp.y + 2 * t, esp_lift + 2.5]);
      // board seat
      translate([t - fit, t - fit, esp_lift]) cube([esp.x + 2 * fit, esp.y + 2 * fit, 10]);
      // open the sides so jumpers reach the header pins
      translate([t + post, -1, -1]) cube([esp.x - 2 * post, esp.y + 2 * t + 2, esp_lift + 5]);
      translate([-1, t + post, -1]) cube([esp.x + 2 * t + 2, esp.y - 2 * post, esp_lift + 5]);
    }
}

module base() {
  difference() {
    union() {
      difference() {
        linear_extrude(base_h) rounded_rect(outer, corner_r);
        translate([wall, wall, floor_t])
          linear_extrude(inner.z + 1) rounded_rect([inner.x, inner.y], corner_r - wall);
      }
      for (p = bosses) translate([p.x, p.y, 0]) cylinder(d = boss_d, h = base_h);
      esp32_cradle();
    }
    for (p = bosses) translate([p.x, p.y, floor_t]) cylinder(d = pilot_d, h = base_h);
    // USB port in the right-hand wall, level with the ESP32's connector
    translate([outer.x - wall - 1, usb_center[0] - usb_cut.x / 2, usb_center[1] - usb_cut.y / 2])
      cube([wall + 2, usb_cut.x, usb_cut.y]);
    // Wall-mount keyholes, 60 mm apart
    for (dx = [-30, 30]) translate([outer.x / 2 + dx, outer.y / 2 - 4, -1]) keyhole();
  }
}

// ---------------------------------------------------------------------------
// Lid (modelled in its assembled position: plate from z = 0 to lid_t,
// locating features hang below z = 0 into the base)
// ---------------------------------------------------------------------------
module frame(pos, size, depth, gap_side = "", gap = 0) {
  t = 1.2;
  translate([pos.x - t - fit, pos.y - t - fit, -depth])
    difference() {
      cube([size.x + 2 * (t + fit), size.y + 2 * (t + fit), depth + 0.01]);
      translate([t, t, -1]) cube([size.x + 2 * fit, size.y + 2 * fit, depth + 2]);
      // opening for the module's header wires
      if (gap_side == "left")
        translate([-1, (size.y + 2 * (t + fit) - gap) / 2, -1]) cube([t + 2, gap, depth + 2]);
      if (gap_side == "top")
        translate([(size.x + 2 * (t + fit) - gap) / 2, size.y + t + 2 * fit - 1, -1]) cube([gap, t + 2, depth + 2]);
    }
}

module contactless_mark() {
  // Card outline with radio waves: the usual "tap here" symbol.
  c = [rc522_pos.x + rc522.x / 2, rc522_pos.y + rc522.y / 2];
  translate([c.x - 12, c.y, 0]) {
    difference() {
      rounded_rect_centered([22, 30], 2.5);
      rounded_rect_centered([19.6, 27.6], 1.5);
    }
    translate([4, 4]) square([6, 4.5]);   // chip
  }
  for (i = [0:2]) translate([c.x + 4, c.y]) wave(7 + i * 6);
}

module rounded_rect_centered(size, r) {
  translate(-size / 2) rounded_rect(size, r);
}

module wave(r) {
  intersection() {
    difference() { circle(r = r + 0.6, $fn = 96); circle(r = r - 0.6, $fn = 96); }
    polygon([[0, 0], [40, -28], [40, 28]]);
  }
}

module lid() {
  difference() {
    union() {
      linear_extrude(lid_t) rounded_rect(outer, corner_r);
      // locating lip that drops inside the base walls
      translate([0, 0, -3])
        difference() {
          translate([wall + fit, wall + fit, 0])
            linear_extrude(3.01) rounded_rect([inner.x - 2 * fit, inner.y - 2 * fit], corner_r - wall);
          translate([wall + fit + 1.2, wall + fit + 1.2, -1])
            linear_extrude(5) rounded_rect([inner.x - 2 * fit - 2.4, inner.y - 2 * fit - 2.4], 0.5);
          for (p = bosses) translate([p.x, p.y, -1]) cylinder(d = boss_d + 1, h = 5);
        }
      frame(rc522_pos, rc522, 4, "left", 24);
      frame(oled_pos, oled, 3, "top", 14);
      // buzzer ring
      translate([buzzer_c.x, buzzer_c.y, -4])
        difference() {
          cylinder(d = buzzer_d + 2 * fit + 2.4, h = 4.01);
          translate([0, 0, -1]) cylinder(d = buzzer_d + 2 * fit, h = 6);
        }
    }
    // countersunk screw holes
    for (p = bosses) translate([p.x, p.y, -5]) {
      cylinder(d = screw_d, h = lid_t + 10);
      translate([0, 0, 5 + lid_t - (head_d - screw_d) / 2]) cylinder(d1 = screw_d, d2 = head_d, h = (head_d - screw_d) / 2 + 0.01);
    }
    // screen window, centred on the glass (the header is along the top edge)
    translate([oled_pos.x + (oled.x - oled_window.x) / 2, oled_pos.y + (oled.y - oled_window.y) / 2 - 2, -1])
      cube([oled_window.x, oled_window.y, lid_t + 2]);
    // buzzer grille
    translate([buzzer_c.x, buzzer_c.y, -1]) {
      cylinder(d = 1.8, h = lid_t + 2);
      for (a = [0:60:300]) rotate(a) translate([3.6, 0, 0]) cylinder(d = 1.8, h = lid_t + 2);
    }
    // tap mark, 0.6 mm deep
    translate([0, 0, lid_t - 0.6]) linear_extrude(1) contactless_mark();
    if (label_text != "")
      translate([oled_pos.x + oled.x / 2, oled_pos.y + oled.y + 3.2, lid_t - 0.6])
        linear_extrude(1) text(label_text, size = 4, halign = "center", valign = "center", font = "Liberation Sans:style=Bold");
  }
}

// ---------------------------------------------------------------------------
// Stand-in modules for the assembly view
// ---------------------------------------------------------------------------
module dummy_modules() {
  color("#2b5fb4") translate([rc522_pos.x, rc522_pos.y, base_h - 3.6]) cube([rc522.x, rc522.y, 1.6]);
  color("#1d2433") translate([oled_pos.x, oled_pos.y, base_h - 2.6]) cube([oled.x, oled.y, 1.6]);
  color("#111111") translate([buzzer_c.x, buzzer_c.y, base_h - 9.5]) cylinder(d = buzzer_d, h = 9.5);
  color("#1b2230") translate([esp_pos.x, esp_pos.y, floor_t + esp_lift]) cube([esp.x, esp.y, 1.6]);
}

if (part == "base") base();
if (part == "lid") translate([0, outer.y, lid_t]) rotate([180, 0, 0]) lid();
if (part == "print") {
  base();
  translate([0, 2 * outer.y + 10, lid_t]) rotate([180, 0, 0]) lid();
}
if (part == "assembly") {
  color("#e8ecf2") base();
  color("#d7dde6", 0.85) translate([0, 0, base_h]) lid();
  dummy_modules();
}
