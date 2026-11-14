# Third-party code and data

- **dxf-parser** (MIT, © GDS Storefront Estimating): the AutoCAD Color Index
  table in `src/import/dxf/color.ts` was extracted from this package.
- **clipper2-ts** (BSL-1.0, TypeScript port of Angus Johnson's Clipper2): used
  as a dependency for polygon offsets (kerf compensation) and for the polygon
  booleans and offsets of the nesting engine. No clipper code is copied into
  this repo; the no-fit polygon construction in `src/nesting/nfp.ts` is our own
  implementation of the published convolution method (Guibas, Ramshaw and
  Stolfi 1983; Wein 2006).
