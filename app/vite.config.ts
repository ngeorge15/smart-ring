import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// singlefile keeps the AirDrop/offline property: one .html, no external assets.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: { alias: {
    "@": new URL("./src", import.meta.url).pathname,
    // ONE copy of the handoff codec, shared with sync.html which loads it as a
    // plain module at runtime. Duplicating it would let the producer and the
    // consumer drift on the wire format, which is the one thing that must not
    // happen across two apps that cannot see each other's storage.
    "@handoff": new URL("../web/handoff.js", import.meta.url).pathname,
  } },
  build: { outDir: "../web/dist", emptyOutDir: true, assetsInlineLimit: 100000000 },
});
