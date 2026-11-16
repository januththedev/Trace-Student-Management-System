import type { NextConfig } from "next";

const security = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];
/** Private surfaces: never cached by browser, service worker or CDN. */
const privateNoStore = [{ key: "Cache-Control", value: "private, no-store, max-age=0" }, { key: "Vary", value: "Cookie" }];

const nextConfig: NextConfig = {
  // Authenticated operational pages are per-request; cacheComponents is off so private data is never prerendered/cached.
  cacheComponents: false,
  poweredByHeader: false,
  // Storage is supplied at runtime. Never ship local receipts, test data or
  // machine-specific configuration inside a server deployment trace.
  outputFileTracingExcludes: {
    "/*": ["./.private-storage/**/*", "./tests/**/*", "./.agents-logs/**/*", "./fixtures/**/*", "./.env*", "./.claude/**/*"],
  },
  turbopack: {
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: security },
      { source: "/me/:path*", headers: privateNoStore },
      { source: "/me", headers: privateNoStore },
      { source: "/staff/:path*", headers: privateNoStore },
      { source: "/staff", headers: privateNoStore },
      { source: "/api/student/:path*", headers: privateNoStore },
      { source: "/api/staff/:path*", headers: privateNoStore },
      { source: "/", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/banners/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }] },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }, { key: "Service-Worker-Allowed", value: "/" }] },
    ];
  },
};

export default nextConfig;
