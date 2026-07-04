import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

// Rsbuild = Rspack (Rust) core + SWC (Rust) transpile. Same team as Midscene (web-infra-dev).
export default defineConfig({
  plugins: [pluginReact()],
  html: {
    title: "TestPilot",
  },
  server: {
    port: 5300,
  },
});
