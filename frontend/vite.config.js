import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import crypto from "node:crypto";

function signAmapParams(params, secret) {
  const sorted = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return crypto
    .createHash("md5")
    .update(sorted + secret)
    .digest("hex");
}

function amapDistrictProxy(env) {
  return {
    name: "amap-district-proxy",
    configureServer(server) {
      server.middlewares.use("/api/amap/district", async (req, res) => {
        try {
          const url = new URL(req.url, "http://localhost");

          const params = new URLSearchParams({
            key: env.AMAP_KEY,
            keywords: url.searchParams.get("keywords") || "中国",
            subdistrict: url.searchParams.get("subdistrict") || "1",
            extensions: url.searchParams.get("extensions") || "base",
            output: url.searchParams.get("output") || "JSON",
          });

          if (env.AMAP_SECRET) {
            params.set("sig", signAmapParams(params, env.AMAP_SECRET));
          }

          const apiUrl = `https://restapi.amap.com/v3/config/district?${params.toString()}`;
          const response = await fetch(apiUrl);
          const data = await response.text();

          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(data);
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              status: "0",
              info: error.message || "amap proxy error",
            })
          );
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react(), tailwindcss(), amapDistrictProxy(env)],
    server: {
      proxy: {
        "/api/backend": {
          target: env.VITE_BACKEND_PROXY_TARGET || "http://127.0.0.1:8000",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/backend/, ""),
        },
      },
    },
    define: {
      "import.meta.env.VITE_AMAP_KEY": JSON.stringify(
        env.VITE_AMAP_KEY || env.AMAP_KEY || ""
      ),
    },
  };
});
