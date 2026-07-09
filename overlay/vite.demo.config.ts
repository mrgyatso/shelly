/* =============================================================================
   Build config for the public, static demo (`npm run build:demo` → dist-demo/).

   Separate from the Tauri build so the app config stays untouched. `base: "./"`
   keeps every asset path relative, so the same bundle serves correctly from a
   subdomain root, a subpath, or a file:// open — the deploy URL is not baked in.
   ============================================================================= */

import { defineConfig } from "vite";
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";

const root = import.meta.dirname;

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist-demo",
    emptyOutDir: true,
    // Monaco + xterm are large and expected; don't fail the build on it.
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: resolve(root, "demo.html") },
  },
  server: {
    // The demo inlines the two stashed artifacts from the repo's demo/ dir,
    // which sits above this Vite root.
    fs: { allow: [root, resolve(root, "..")] },
  },
  plugins: [
    {
      name: "demo-index-alias",
      // Static hosts serve `index.html` at a directory root; the source entry is
      // `demo.html`, so publish it under both names. `writeBundle` (not
      // `closeBundle`) — the latter also fires on a failed build, where the copy
      // would throw ENOENT and mask the real error.
      writeBundle() {
        const out = resolve(root, "dist-demo");
        copyFileSync(resolve(out, "demo.html"), resolve(out, "index.html"));
      },
    },
  ],
});
