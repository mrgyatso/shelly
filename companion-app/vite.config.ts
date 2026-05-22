import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Bundle the UI (HTML + TS + CSS) into one self-contained HTML file that the
// MCP server serves as the `ui://` resource. The host renders it in a sandboxed
// iframe, so everything it needs must be inlined — hence singlefile.
export default defineConfig({
  root: "ui",
  plugins: [viteSingleFile()],
  build: {
    outDir: "../ui-dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
