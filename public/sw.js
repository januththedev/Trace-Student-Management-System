// T2T Student Portal service worker — strict allowlist caching.
// Everything under /api/ (except /api/public/courses), /me, /staff, HTML
// navigations and any response marked no-store/private is never intercepted
// or stored here.
/* global importScripts */
if (typeof importScripts === "function") {
  importScripts("/sw-policy.js");
}

var STATIC_CACHE = "t2t-static-v1";
var PRECACHE_URLS = [
  "/offline.html",
  "/brand/t2t-logo.png",
  "/icons/icon-192.png",
  "/banners/fallback.webp"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then(function (cache) {
        return cache.addAll(PRECACHE_URLS);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            if (key !== STATIC_CACHE) return caches.delete(key);
            return undefined;
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

function isCacheableResponse(response) {
  if (!response || !response.ok) return false;
  if (response.type !== "basic") return false;
  var cacheControl = response.headers.get("cache-control") || "";
  if (/(^|,\s*)(no-store|private)(\s*,|$)/i.test(cacheControl)) return false;
  return true;
}

function cachePut(request, response) {
  if (!isCacheableResponse(response)) return Promise.resolve();
  var copy = response.clone();
  return caches
    .open(STATIC_CACHE)
    .then(function (cache) {
      return cache.put(request, copy);
    })
    .catch(function () {});
}

function cacheFirst(request) {
  return caches.match(request).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (response) {
      cachePut(request, response);
      return response;
    });
  });
}

function staleWhileRevalidate(request) {
  var network = fetch(request)
    .then(function (response) {
      cachePut(request, response);
      return response;
    })
    .catch(function () {
      return undefined;
    });
  return caches.match(request).then(function (cached) {
    if (cached) {
      network.then(function () {});
      return cached;
    }
    return network.then(function (fresh) {
      return fresh || Response.error();
    });
  });
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;

  var url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  var decision = self.shouldCache(url.pathname, request.method, request.mode);

  if (decision === "none") {
    if (request.mode === "navigate") {
      event.respondWith(
        fetch(request).catch(function () {
          return caches.match("/offline.html");
        })
      );
    }
    return;
  }

  if (decision === "swr") {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "CLEAR_PRIVATE") {
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            if (key !== STATIC_CACHE) return caches.delete(key);
            return undefined;
          })
        );
      })
      .catch(function () {});
  }
});
