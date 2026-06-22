// Ambient declarations for CSS side-effect imports (e.g. `import './foo.css'`).
// esbuild bundles these at build time; TypeScript only needs a module shape so
// that side-effect imports type-check. TypeScript 6.0 began erroring (TS2882)
// on side-effect imports that resolve to no declaration, so declare them here.
declare module '*.css' {}
