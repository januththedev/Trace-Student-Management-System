import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { shouldCache } = require("../../public/sw-policy.js") as {
  shouldCache: (
    url: string,
    method: string,
    mode: string
  ) => "static" | "swr" | "none";
};

describe("sw policy: allowlist", () => {
  it("never caches private or staff surfaces", () => {
    expect(shouldCache("/me", "GET", "navigate")).toBe("none");
    expect(shouldCache("/me", "GET", "cors")).toBe("none");
    expect(shouldCache("/staff/review", "GET", "cors")).toBe("none");
    expect(shouldCache("/staff/review/abc", "GET", "cors")).toBe("none");
    expect(shouldCache("/api/student/submissions", "GET", "cors")).toBe("none");
    expect(shouldCache("/api/staff/review/x/evidence", "GET", "cors")).toBe(
      "none"
    );
  });

  it("never caches any API route except the public courses feed", () => {
    expect(shouldCache("/api/student/me", "GET", "cors")).toBe("none");
    expect(shouldCache("/api/staff/enrolments", "GET", "cors")).toBe("none");
    expect(shouldCache("/api/public/courses", "GET", "cors")).toBe("swr");
  });

  it("treats navigations as network-only (offline fallback handled separately)", () => {
    expect(shouldCache("/staff", "GET", "navigate")).toBe("none");
    expect(shouldCache("/_next/static/chunk.js", "GET", "navigate")).toBe(
      "none"
    );
  });

  it("never caches non-GET requests", () => {
    expect(shouldCache("/api/public/courses", "POST", "cors")).toBe("none");
    expect(shouldCache("/_next/static/chunk.js", "POST", "cors")).toBe("none");
    expect(shouldCache("/banners/fallback.webp", "PUT", "cors")).toBe("none");
  });

  it("caches static build assets, fonts and public images cache-first", () => {
    expect(shouldCache("/_next/static/chunks/main-abc123.js", "GET", "cors")).toBe(
      "static"
    );
    expect(shouldCache("/_next/static/css/app.css", "GET", "cors")).toBe(
      "static"
    );
    expect(shouldCache("/banners/fallback.webp", "GET", "cors")).toBe("static");
    expect(shouldCache("/brand/t2t-logo.png", "GET", "cors")).toBe("static");
    expect(shouldCache("/icons/icon-192.png", "GET", "cors")).toBe("static");
    expect(shouldCache("/fonts/inter-var.woff2", "GET", "cors")).toBe("static");
    expect(shouldCache("/fonts/inter.woff", "GET", "cors")).toBe("static");
  });

  it("does not cache first-party pages that merely look asset-like", () => {
    expect(shouldCache("/", "GET", "cors")).toBe("none");
    expect(shouldCache("/students/abc", "GET", "cors")).toBe("none");
    expect(shouldCache("/export.csv", "GET", "cors")).toBe("none");
  });

  it("swr applies only to the public courses feed", () => {
    expect(shouldCache("/api/public/courses", "GET", "cors")).toBe("swr");
    expect(shouldCache("/api/public/courses/", "GET", "cors")).toBe("swr");
    expect(shouldCache("/api/public/courses-other", "GET", "cors")).toBe("none");
    expect(shouldCache("/api/public/coursesX", "GET", "cors")).toBe("none");
  });
});
