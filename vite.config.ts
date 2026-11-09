import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { appInfo } from "./scripts/package-info.mjs";

// The app's name comes from package.json only (via scripts/package-info.mjs).
export default defineConfig({
  plugins: [
    react(),
    {
      name: "insert-package-info-in-html",
      transformIndexHtml: (html) => html.replaceAll("%APP_NAME%", appInfo.name),
    },
  ],
  define: {
    __APP_ID__: JSON.stringify(appInfo.id),
    __APP_NAME__: JSON.stringify(appInfo.name),
  },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "safari15" },
});
