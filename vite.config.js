import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/pscpp-study-radar/",
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["radar-icon.svg"],
      manifest: {
        name: "PSCPP Study Radar",
        short_name: "PSCPP Radar",
        description: "Estudo e revisão adaptativa para o PSCPP/DPC.",
        theme_color: "#071622",
        background_color: "#06121c",
        lang: "pt-BR",
        display: "standalone",
        start_url: "/pscpp-study-radar/",
        scope: "/pscpp-study-radar/",
        icons: [{src:"radar-icon.svg",sizes:"any",type:"image/svg+xml",purpose:"any maskable"}]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,json,svg}"],
        navigateFallback: "index.html"
      }
    })
  ]
});
