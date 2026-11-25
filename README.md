<p align="center">
  <img src="assets/banner.jpg" alt="Dual Koi Portfolio Banner" width="100%">
</p>

# Saayan Chowdhury | Dual Koi Portfolio

> 🌐 **Live Demo:** [https://dual-koi-portfolio.vercel.app/](https://dual-koi-portfolio.vercel.app/)

An interactive, canvas-driven dual portfolio. It blends traditional Japanese art aesthetics—**Mokkotsu** (boneless watercolor) and **Sumi-e** (ink wash)—with real-time fish flocking physics and interactive fluid dynamics.

---

## Features

- **Autonomous Koi Simulation**: Real-time fish flocking/steering physics, obstacle avoidance, spine curvature kinematics, anatomical 12-ray caudal fins, and wake/ripple wave propagation.
- **Dual Visual Styles**:
  - **Mokkotsu**: Rich, full-color watercolor presentation on Torinoko washi parchment.
  - **Sumi-e**: High-contrast, minimalist Japanese Zen ink wash styling with procedural paper and blossom sprites.
- **Navier–Stokes Fluid Mask Engine**: Real-time WebGL/WebGL2 fluid advection and diffusion simulating spilled liquid ink that bleeds across the screen to transition between visual styles.
- **4-Column Brocade Portfolio UI**: Imperial crimson brocade cards that unfold via a 2.5D cube-grid shockwave into vertical floral scroll paintings with custom typography (`KanjiBrutalist`).
- **Archive Scroll Gallery (`秘術 Archive Scroll`)**: Unfolded parchment gallery showcasing grouped certificates, awards, and event photography with an interactive zoom lightbox and keyboard navigation (`←`, `→`, `Esc`).
- **Mizuhiki Coin Chain Controls**: Sculpted 3D cast-metal medallions suspended on a physics-driven braided Mizuhiki cord with coupled pendulum sway.
- **Dynamic Age Telemetry**: Live counter accurately computing exact elapsed years, months, days, hours, minutes, and seconds based on local time.
- **Day & Night Synchronization**: Automatically matches pond illumination, sun/moon cycles, fireflies, and dragonflies to your local clock, featuring an interactive lantern flashlight in night mode.
- **Zero Runtime Dependencies**: Built with pure TypeScript, WebGL/WebGL2, and HTML5 Canvas.

---

## Interactive Controls & Features

### 1. Pond & Water Surface
* **Disturbing Water & Guiding Koi**: Moving your pointer across the pond leaves subtle wake ripples that fish steer around or follow.
* **Water Ripples**: Clicking anywhere on open water produces an expanding concentric water ripple across the pond surface.

---

### 2. Top-Right Floating Controls
* **Sun / Moon Button (`Lighting Mode`)**:
  * Toggles between bright daylight and moonlit night mode.
  * When untouched, lighting automatically synchronizes with your local system clock (day vs. evening).
* **Oni Mask Button (`Portfolio Reveal`)**:
  * Toggles the 4-column portfolio overlay open and closed with a wave ripple effect across the pond.
* **Archive Scroll Button (`秘術 Archive Scroll`)**:
  * Opens the unfolded certificates, awards, and event photography gallery scroll with a zoom lightbox.
* **GitHub & LinkedIn Buttons**:
  * Direct links to the repository and Saayan's LinkedIn profile, suspended on the animated Mizuhiki coin chain.
* **Lantern Button (`Dark Mode Flashlight`)**:
  * Appears exclusively during Night Mode.
  * Toggles an interactive illuminated spotlight beam that follows your pointer through the darkness. When idle, the lantern drifts in a gentle, ambient path.

---

### 3. Portfolio Columns & Navigation
When the portfolio is opened, four crimson brocade columns appear.

* **Expanding a Folio**: Click on any column to expand it into an accordion view. The selected column expands into an illustrated floral scroll while shrinking the others:
  * **Folio 01 — Subject & Provenance**: Personal biography, experience history, dynamic live age breakdown, and direct contact channels (`tel:`, `mailto:`, GitHub, LinkedIn).
  * **Folio 02 — Education & Journey**: Academic background, coursework, and milestones.
  * **Folio 03 — Capabilities & Arsenal**: Categorized technical skills, tools, and methodologies.
  * **Folio 04 — Works & Projects**: Interactive project catalog. Click any project entry to switch/expand its pipeline, tech stack, and highlights.
* **Collapsing a Folio**: Click the currently expanded column (or its `[ FOLD SCROLL ]` footer button) to return to the balanced 4-column view.

---

### 4. Archive Scroll Gallery (`秘術 Archive Scroll`)
* **Opening & Browsing**: Click the **Archive Scroll** coin button to unfold the certificates, awards, and event photography scroll.
* **Zoom Lightbox**: Click any tile to inspect its slides in the lightbox. Use the `<` / `>` buttons, pagination dots, or `ArrowLeft` / `ArrowRight` keys to step through grouped images, and `Esc` (or clicking outside) to close.

---

### 5. Portrait Frame
* **Toggling Photo / Illustration**: Whenever the portfolio is open, click directly on the circular portrait frame in the left pond pane to toggle between the painted illustration (Mokkotsu / Sumi-e ink portrait) and Saayan's photograph.

---

### 6. Fluid Ink Style Transition (Mokkotsu ↔ Sumi-e)
You can transition the visual presentation between watercolor and ink wash at any time using gesture-based fluid dynamics:

* **Click & Drag / Swipe**: Press and drag across the screen to inject turbulent liquid ink onto the canvas.
* **Style Swap Threshold**:
  * **Drag past ~60% screen coverage**: The liquid ink floods the entire viewport and seamlessly flips the active style (Mokkotsu to Sumi-e or vice-versa).
  * **Release before 60%**: The fluid ink naturally retracts and dissolves back into the water.

---

## Project Structure

```
├── src/
│   ├── koi/
│   │   ├── caudalFin.ts          # Anatomical caudal fin geometry & 12-ray spline solver
│   │   ├── columnArtData.ts      # Embedded artwork textures and base64 assets
│   │   ├── engine.ts             # Core Koi pond loop and UI control orchestration
│   │   ├── galleryData.ts        # Archive Scroll certificates, awards & metadata
│   │   ├── galleryMediaData.ts   # Embedded Archive Scroll photography assets
│   │   ├── galleryScroll.ts      # Unfolded Archive Scroll & zoom lightbox UI
│   │   ├── index.ts              # Koi module barrel exports
│   │   ├── koiGeometry.ts        # Spine kinematics, fin anchors, and fish outline curves
│   │   ├── koiMath.ts            # Deterministic PRNG, 2D noise, and color helpers
│   │   ├── koiPond.ts            # Pond palettes, wake field, and concentric ripples
│   │   ├── koiRenderer.ts        # Canvas-based fish body and pond surface renderer
│   │   ├── koiSimulation.ts      # Multi-agent fish boid physics, steering, and geometry
│   │   ├── koiTypes.ts           # Type definitions for Koi anatomy and physics state
│   │   ├── koiVarieties.ts       # Color varieties (Kohaku, Taisho Sanke, Showa, etc.)
│   │   ├── mizuhikiCoins.ts      # 3D cast-metal coin medallions & Mizuhiki chain physics
│   │   ├── pondWorld.ts          # Boundary simulation and obstacle avoidance
│   │   ├── portfolioColumns.ts   # 4-column brocade and floral accordion UI
│   │   ├── portfolioData.ts      # Profile bio, dynamic age calculator, and projects
│   │   ├── rippleField.ts        # 2D discrete wave ripple grid
│   │   └── sumieWash.ts          # Sumi-e ink wash procedural paper & blossom sprites
│   ├── fluidMaskEngine.ts        # WebGL Navier-Stokes fluid advection and layer mask
│   ├── index.ts                  # Library barrel exports
│   ├── kanjiFontData.ts          # Custom font definitions
│   ├── koiFluidApp.ts            # Dual-layer manager binding Mokkotsu and Sumi-e engines
│   ├── math.ts                   # Shared math utilities
│   └── sharedState.ts            # State synchronization between visual layers
├── demo.ts                       # Application mount entrypoint
├── index.html                    # Root HTML document
└── vite.config.ts                # Bundler configuration
```

---

## Getting Started

### Prerequisites
- Node.js (v18 or higher recommended)
- npm or pnpm

### Installation

```bash
# Clone the repository
git clone https://github.com/Saayan-Chowdhury-2004/Dual_KOI_Portfolio.git

# Navigate into the project directory
cd Dual_KOI_Portfolio

# Install dependencies
npm install
```

### Development Server

```bash
npm run dev
```

Visit the local URL shown in your terminal (usually `http://localhost:5173`) to view the portfolio.

### Production Build

```bash
npm run build
```

Build outputs are generated in the `dist/` directory.

---

## License

Private / All Rights Reserved © Saayan Chowdhury.
