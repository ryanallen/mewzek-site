const SHELL_CACHE = "mewzek-shell-v10";
const DATA_CACHE = "mewzek-data-v2";
const AUDIO_CACHE = "mewzek-audio-v1";
let audioGeneration = 0;
const trackGeneration = new Map();

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.allSettled([
      "/", "/assets/style.css?v=34", "/assets/app.js?v=44",
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

function audioKey(id) {
  return new Request(new URL(`/api/stream/${encodeURIComponent(id)}`, self.location.origin));
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
    if (response.ok && response.type === "basic") await cache.put(request, response.clone());
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
      const saved = await cache.match(audioKey(decodeURIComponent(url.pathname.slice(12))));
      try {
        const response = await fetch(request);
        if (response.ok || !saved) return response;
      } catch {
        if (!saved) return Response.error();
      }
      return rangeResponse(saved, request.headers.get("Range"));
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

async function saveTrack(id) {
  const generation = audioGeneration;
  const trackVersion = trackGeneration.get(id) || 0;
  const key = audioKey(id);
  const cache = await caches.open(AUDIO_CACHE);
  if (await cache.match(key)) return { saved: true };
  const response = await fetch(new Request(key, { credentials: "same-origin", cache: "no-store" }));
  if (response.status !== 200 || !response.headers.get("Content-Type")?.startsWith("audio/")) {
    throw new Error("Audio is not ready to save offline");
  }
  if (generation !== audioGeneration || trackVersion !== (trackGeneration.get(id) || 0)) {
    return { saved: false };
  }
  await cache.put(key, response);
  if (generation !== audioGeneration || trackVersion !== (trackGeneration.get(id) || 0)) {
    await cache.delete(key);
    return { saved: false };
  }
  return { saved: true };
}

self.addEventListener("message", (event) => {
  const { type, id } = event.data || {};
  const reply = event.ports[0];
  event.waitUntil((async () => {
    try {
      let result = {};
      if (type === "save-track" && /^[A-Za-z0-9:_-]{1,100}$/.test(id || "")) {
        result = await saveTrack(id);
      } else if (type === "remove-track" && /^[A-Za-z0-9:_-]{1,100}$/.test(id || "")) {
        trackGeneration.set(id, (trackGeneration.get(id) || 0) + 1);
        result = { removed: await (await caches.open(AUDIO_CACHE)).delete(audioKey(id)) };
      } else if (type === "clear-downloads") {
        audioGeneration++;
        result = { cleared: await caches.delete(AUDIO_CACHE) };
      } else if (type === "warm") {
        const profile = ["Ryan", "Karryn", "Parker", "Wren"].includes(id?.profile) ? id.profile : "Ryan";
        const cache = await caches.open(`${DATA_CACHE}-${profile}`);
        const extra = Array.isArray(id?.paths) ? id.paths.filter((path) =>
          typeof path === "string" && path.startsWith("/api/") && !path.startsWith("/api/device/")) : [];
        for (const path of ["/api/me", "/api/playlists", "/api/coverage", ...extra]) {
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
