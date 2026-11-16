// T2T service worker cache policy. Classic script (loaded via importScripts)
// that also exposes itself to tests when a CommonJS module context exists.
(function () {
  "use strict";

  var STATIC_PATTERNS = [
    /^\/_next\/static\//,
    /^\/banners\//,
    /^\/brand\//,
    /^\/icons\//,
    /\.(woff2?)$/i
  ];

  function shouldCache(url, method, mode) {
    if (method !== "GET") return "none";
    if (mode === "navigate") return "none";

    var pathname;
    try {
      pathname = new URL(url, "http://t2t.invalid").pathname;
    } catch (err) {
      return "none";
    }

    if (pathname === "/api/public/courses" || pathname.indexOf("/api/public/courses/") === 0) {
      return "swr";
    }
    if (pathname.indexOf("/api/") === 0) return "none";

    for (var i = 0; i < STATIC_PATTERNS.length; i++) {
      if (STATIC_PATTERNS[i].test(pathname)) return "static";
    }
    return "none";
  }

  if (typeof self !== "undefined") self.shouldCache = shouldCache;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { shouldCache: shouldCache };
  }
})();
