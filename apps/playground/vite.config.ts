import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Pinna's packages from their source, so the playground needs no build of them.
  resolve: { conditions: ["source", ...defaultClientConditions] },
});
