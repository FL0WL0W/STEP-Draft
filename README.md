# STEP Draft Viewer

A browser-based STEP draft-analysis viewer built with OpenCascade.js, Three.js, and Webpack.

The app imports STEP files, stores the last uploaded file in `localStorage`, reloads it automatically on refresh, evaluates draft/overhang behavior with OpenCascade, splits supported analytic faces at pass/fail boundaries, renders the result with Three.js, and can export the split STEP file.

## Features

- Upload `.step` / `.stp` files.
- Automatically restore the last uploaded STEP file after page reload.
- Set draft angle, defaulting to `3` degrees.
- Analyze face normals analytically in OpenCascade, not from render triangles.
- Split supported primitive faces at draft/overhang transition boundaries.
- Render OCCT boundary edges instead of deriving edges from triangulation.
- Download the split STEP result.
- Use FreeCAD-like light gray body colors, red failing faces, and orange mixed/failed-split diagnostic faces.

## Supported Split Surfaces

Current analytic split support covers:

- Planes
- Cylinders
- Cones, including apex cones via parametric U splitting
- Spheres
- Tori, including arbitrary-axis tori using generated OCCT split surfaces

## Important Geometry Rule

Triangles are used only to render the final shape in Three.js. Draft analysis, overhang checks, face identification, boundary extraction, and splitting are driven by OpenCascade geometry and topology.

## Getting Started

Install dependencies:

```bash
npm install
```

Run the dev server:

```bash
npm run dev
```

Open:

```text
http://localhost:3011
```

Build for production:

```bash
npm run build
```

The production build is written to `dist/`.

## Project Structure

- `src/main.js` - Three.js viewer, UI controls, local storage, and rendering.
- `src/occtPipeline.js` - STEP import/export, OCCT topology traversal, face splitting, meshing for display, and boundary extraction.
- `src/findSplitSurface.js` - Analytic split surface calculations for supported primitive surfaces.
- `src/styles.css` - App styling.
- `webpack.config.js` - Webpack and dev-server config, including port `3011`.

## Notes

OpenCascade.js exposes some OCCT APIs through generated WebAssembly bindings with incomplete or awkward overload support. The pipeline includes small binding adapters for constructor overloads, handle upcasts, and API variants needed by this app.
