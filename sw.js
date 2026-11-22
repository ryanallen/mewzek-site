// The landing site (mewzek-site) serves this same file at mewzek.com off home Wi-Fi.
// deploy/sync_site_worker.sh pushes it there whenever it changes on Lancre.
const SHELL_CACHE = "mewzek-shell-v82";
const DATA_CACHE = "mewzek-data-v2";
const AUDIO_CACHE = "mewzek-audio-v2";
const ARTWORK_CACHE_LIMIT = 80;
const CHART_CACHE_LIMIT = 128;
let audioGeneration = 0;
const trackGeneration = new Map();

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.allSettled([
      "/", "/assets/style.css?v=41", "/assets/app.js?v=91",
      "/assets/game.css?v=8", "/assets/game.js?v=18",
      "/assets/mewzek-cat-earbuds.png", "/assets/profile-kittens.png", "/manifest.webmanifest",
    ].map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("mewzek-") && ![SHELL_CACHE, AUDIO_CACHE].includes(name) && !name.startsWith(DATA_CACHE + "-")) {
        await caches.delete(name);
      }
    }
    await self.clients.claim();
  })());
});

function audioKey(id, version = "") {
  const path = `/api/stream/${encodeURIComponent(id)}`;
  return new Request(new URL(version ? `${path}?v=${encodeURIComponent(version)}` : path, self.location.origin));
}

async function removeAudioVersions(cache, id, keepUrl = null) {
  const path = `/api/stream/${encodeURIComponent(id)}`;
  let removed = false;
  for (const key of await cache.keys()) {
    if (new URL(key.url).pathname === path && key.url !== keepUrl) {
      removed = await cache.delete(key) || removed;
    }
  }
  return removed;
}

async function rangeResponse(cached, range) {
  if (!range) return cached;
  const bytes = await cached.arrayBuffer();
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return new Response(null, { status: 416 });
  const total = bytes.byteLength;
  let start = match[1] ? Number(match[1]) : Math.max(0, total - Number(match[2]));
  let end = match[1] && match[2] ? Number(match[2]) : total - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= total || end < start) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
  }
  end = Math.min(end, total - 1);
  return new Response(bytes.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": cached.headers.get("Content-Type") || "audio/mp4",
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}

async function cachedFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const saved = await cache.match(request, request.mode === "navigate" ? { ignoreSearch: true } : undefined);
  try {
    const response = await fetch(request);
    if (request.mode === "navigate") {
      const isPlayer = response.ok && (await response.clone().text()).includes('id="app"');
      if (!isPlayer) return response;
    }
    if (response.status === 404 && saved) return saved;
    if (response.ok && response.type === "basic") {
      try {
        const isArtwork = new URL(request.url).pathname.startsWith("/api/artwork/");
        const bytes = Number(response.headers.get("Content-Length"));
        if (isArtwork && (!Number.isFinite(bytes) || bytes < 1 || bytes > 512 * 1024)) return response;
        if (isArtwork && !saved) {
          const artwork = (await cache.keys()).filter((key) => new URL(key.url).pathname.startsWith("/api/artwork/"));
          for (const key of artwork.slice(0, Math.max(0, artwork.length - ARTWORK_CACHE_LIMIT + 1))) {
            await cache.delete(key);
          }
        }
        const isChart = new URL(request.url).pathname.startsWith("/api/game/chart/");
        if (isChart && !saved) {
          const charts = (await cache.keys()).filter((key) => new URL(key.url).pathname.startsWith("/api/game/chart/"));
          for (const key of charts.slice(0, Math.max(0, charts.length - CHART_CACHE_LIMIT + 1))) {
            await cache.delete(key);
          }
        }
        await cache.put(request, response.clone());
      } catch {}
    }
    return response;
  } catch {
    return saved || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/stream/")) {
    event.respondWith((async () => {
      const cache = await caches.open(AUDIO_CACHE);
      const id = decodeURIComponent(url.pathname.slice(12));
      const version = url.searchParams.get("v") || "";
      const key = audioKey(id, version);
      const range = request.headers.get("Range");
      const saved = await cache.match(key);
      if (saved?.status === 200 && saved.headers.get("Content-Type")?.startsWith("audio/")) {
        if (version) await removeAudioVersions(cache, id, key.url);
        return rangeResponse(saved, range);
      }
      if (range && !/^bytes=0-(?:\d*)$/.test(range)) return fetch(request);
      try {
        const response = await fetch(new Request(key, { credentials: "same-origin", cache: "no-store" }));
        if (response.status === 200 && response.headers.get("Content-Type")?.startsWith("audio/")) {
          event.waitUntil(saveAudioIfRoom(cache, key, response.clone()).then(async (saved) => {
            if (saved && version) await removeAudioVersions(cache, id, key.url);
          }));
        }
        return response;
      } catch { return Response.error(); }
    })());
  } else if (request.mode === "navigate") {
    event.respondWith(cachedFirst(request, SHELL_CACHE));
  } else if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/device/")) {
    const profile = request.headers.get("X-Mewzek-Profile") || "Ryan";
    event.respondWith(cachedFirst(request, `${DATA_CACHE}-${profile}`));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cachedFirst(request, SHELL_CACHE));
  }
});

async function saveAudioIfRoom(cache, key, response) {
  try {
    const bytes = Number(response.headers.get("Content-Length"));
    const estimate = await navigator.storage?.estimate?.();
    if (!Number.isFinite(bytes) || bytes < 1024) return false;
    if (estimate?.quota) {
      const reserve = Math.max(100 * 1024 * 1024, estimate.quota * 0.1);
      if (estimate.quota - estimate.usage < bytes + reserve) return false;
    }
    const keys = await cache.keys();
    let savedBytes = 0;
    for (const item of keys) {
      const saved = await cache.match(item);
      savedBytes += Number(saved?.headers.get("Content-Length")) || 0;
    }
    if (savedBytes + bytes > 256 * 1024 * 1024) return false;
    await cache.put(key, response);
    const id = decodeURIComponent(new URL(key.url).pathname.split("/").pop());
    for (const client of await self.clients.matchAll({ type: "window" })) {
      client.postMessage({ type: "audio-saved", id });
    }
    return true;
  } catch { return false; }
}

async function saveTrack(id, version = "") {
  const generation = audioGeneration;
  const trackVersion = trackGeneration.get(id) || 0;
  const key = audioKey(id, version);
  const cache = await caches.open(AUDIO_CACHE);
  if (await cache.match(key)) {
    if (version) await removeAudioVersions(cache, id, key.url);
    return { saved: true };
  }
  const response = await fetch(new Request(key, { credentials: "same-origin", cache: "no-store" }));
  if (response.status !== 200 || !response.headers.get("Content-Type")?.startsWith("audio/")) {
    throw new Error("Audio is not ready to save offline");
  }
  if (generation !== audioGeneration || trackVersion !== (trackGeneration.get(id) || 0)) {
    return { saved: false };
  }
  const saved = await saveAudioIfRoom(cache, key, response);
  if (generation !== audioGeneration || trackVersion !== (trackGeneration.get(id) || 0)) {
    if (saved) await cache.delete(key);
    return { saved: false };
  }
  if (saved && version) await removeAudioVersions(cache, id, key.url);
  return { saved };
}

self.addEventListener("message", (event) => {
  const { type, id } = event.data || {};
  const reply = event.ports[0];
  event.waitUntil((async () => {
    try {
      let result = {};
      if (type === "save-track" && /^[A-Za-z0-9:_-]{1,100}$/.test(id?.track_id || id || "")
          && /^[A-Za-z0-9_.-]{0,100}$/.test(id?.version || "")) {
        result = await saveTrack(id?.track_id || id, id?.version || "");
      } else if (type === "remove-track" && /^[A-Za-z0-9:_-]{1,100}$/.test(id || "")) {
        trackGeneration.set(id, (trackGeneration.get(id) || 0) + 1);
        const cache = await caches.open(AUDIO_CACHE);
        result = { removed: await removeAudioVersions(cache, id) };
      } else if (type === "clear-downloads") {
        audioGeneration++;
        result = { cleared: await caches.delete(AUDIO_CACHE) };
      } else if (type === "warm") {
        const profile = ["Ryan", "Karryn", "Parker", "Wren"].includes(id?.profile) ? id.profile : "Ryan";
        const cache = await caches.open(`${DATA_CACHE}-${profile}`);
        const extra = Array.isArray(id?.paths) ? id.paths.filter((path) =>
          typeof path === "string" && path.startsWith("/api/") && !path.startsWith("/api/device/")) : [];
        for (const path of [...extra, ...(id?.core === false ? [] : ["/api/me", "/api/playlists", "/api/coverage"])]) {
          const request = new Request(path, { credentials: "same-origin", headers: { "X-Mewzek-Profile": profile } });
          const response = await fetch(request);
          if (response.ok) await cache.put(request, response);
        }
      }
      reply?.postMessage(result);
    } catch (error) {
      reply?.postMessage({ error: String(error.message || error) });
    }
  })());
});
