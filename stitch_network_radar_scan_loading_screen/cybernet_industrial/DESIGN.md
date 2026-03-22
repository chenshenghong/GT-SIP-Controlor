# Design System Strategy: Tactical Intelligence & Industrial Depth

## 1. Overview & Creative North Star: "The Obsidian Command"
This design system moves beyond the standard "dark mode" dashboard to create a high-fidelity, industrial-grade terminal experience. The Creative North Star is **The Obsidian Command**: a digital environment that feels like a physical piece of mission-critical hardware—dense, authoritative, and illuminated from within.

We break the "generic SaaS" mold by rejecting soft rounded corners and standard separators. Instead, we embrace a **Brutalist Precision** aesthetic—using absolute sharp edges (`0px` radius), aggressive monospace typography, and depth created through luminosity rather than traditional drop shadows. The layout should feel like a high-end radar HUD: intentional asymmetry, data-dense clusters, and "glowing" interactive nodes.

---

## 2. Colors: The Luminescent Void
The palette is rooted in the `surface` (#0c1324), a deep, cold slate that provides the "void" for our data to inhabit.

### The "No-Line" Rule
Traditional 1px solid borders are strictly prohibited for layout sectioning. In this system, boundaries are defined by **Atmospheric Shifts**. To separate the sidebar from the main feed, transition from `surface` to `surface_container_low`. To highlight a terminal readout, nest a `surface_container_lowest` block within a `surface_container` area.

### Surface Hierarchy & Nesting
Treat the UI as a series of recessed or extruded metal plates. 
- **Base Level:** `surface` (#0c1324) for the overall application background.
- **Recessed Data Wells:** Use `surface_container_lowest` (#070d1f) for areas where data is "read-only" or historical.
- **Active Tactical Layers:** Use `surface_container_high` (#23293c) for interactive panes or floating utility panels.

### The "Glass & Gradient" Rule
To prevent the dark theme from feeling "flat," use semi-transparent overlays of `primary_container` (#10b981) at 5-10% opacity with a `backdrop-blur` of 12px for floating modals. 
**Signature Texture:** Main CTAs should utilize a linear gradient from `primary` (#4edea3) to `primary_container` (#10b981) at a 135-degree angle to simulate a glowing phosphor screen.

---

## 3. Typography: Monospace Authority
We utilize **Space Grotesk** across all scales to maintain a technical, engineered feel that remains legible at high densities.

*   **Display & Headlines:** Use `display-lg` (3.5rem) for critical system status (e.g., "NETWORK SECURE") with wide letter-spacing (0.05em).
*   **Tactical Data:** `title-sm` (1rem) and `label-md` (0.75rem) are the workhorses of this system. Use them for IP addresses, MAC IDs, and port status. 
*   **The Contrast Rule:** Pair `on_surface` (#dce1fb) for primary data with `on_surface_variant` (#bbcabf) for metadata to create immediate visual scanning hierarchy without using different font weights.

---

## 4. Elevation & Depth: Tonal Layering
In a world of `0px` radii, depth is achieved through light, not physics.

*   **The Layering Principle:** Instead of shadows, use **inner glows**. A card doesn't sit "on top" of the background; it is a "lit zone." Stack `surface_container_low` on `surface` to create a subtle lift.
*   **Ambient Shadows:** If a floating element (like a context menu) requires a shadow, use a large 40px blur with the color `#000000` at only 15% opacity, tinted with `primary` (#4edea3) at 5% to simulate the "glow" of the terminal onto the surface behind it.
*   **The Ghost Border:** For high-alert elements, use the `outline_variant` (#3c4a42) at 20% opacity. This creates a "wireframe" feel common in industrial schematics.
*   **Grid Pattern:** Overlay a 24px x 24px grid using `outline` (#86948a) at 5% opacity across the `background` to reinforce the "scanning" metaphor.

---

## 5. Components: Tactical Modules

### Buttons (Tactical Triggers)
*   **Primary:** High-contrast `primary` (#4edea3) background with `on_primary` (#003824) text. `0px` border radius. On hover, add a 4px outer glow using `primary_container`.
*   **Secondary:** Ghost style. `outline` border at 30% opacity. Text in `secondary` (#4cd7f6).

### Chips (Node Tags)
*   Use `surface_container_highest` for the background and `primary` for the text. Use a leading 4px "status dot" that pulses for active network nodes.

### Input Fields (Command Entry)
*   Forbid standard boxes. Use a bottom-border only (2px) using `outline_variant`. When focused, the border transitions to `secondary` (#4cd7f6) with a subtle vertical gradient "rising" from the line.

### Cards & Lists (Data Clusters)
*   **No Dividers:** Separate list items using `spacing-4` (0.9rem) of vertical space. 
*   **Zebra-Striping:** Use alternating backgrounds of `surface_container_low` and `surface_container` for large data tables (e.g., port scan results).

### Custom Component: The Radar Scanner
*   A circular element using `secondary_container` (#03b5d3) with a sweeping 45-degree conic gradient that rotates. Interactive "blips" are represented by `primary` (#4edea3) dots with a 10px outer glow.

---

## 6. Do's and Don'ts

### Do
*   **Use Asymmetry:** Place critical system alerts off-center to draw the eye; industrial machines aren't always symmetrical.
*   **Embrace Density:** This application is for experts. Don't fear high-density data tables as long as the typographic hierarchy is clear.
*   **Color as Status:** Use `primary` (Green) for "Safe," `secondary` (Cyan) for "Scanning," and `error` (Coral) for "Breach."

### Don't
*   **No Rounded Corners:** Never use `border-radius`. Everything is a hard, machined edge.
*   **No Generic Shadows:** Avoid the "fuzzy grey" shadow. If an element needs to pop, use a glow or a background color shift.
*   **No Default Spacing:** Avoid 8px/16px defaults. Use the custom Spacing Scale (e.g., `2.5` for 0.5rem) to create tight, technical clusters of information.