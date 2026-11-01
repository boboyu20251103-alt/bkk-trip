// 由 tools/publish.py 產生，勿手改。
// 網路優先；慢網路、斷線或 HTTP 錯誤退回安裝時完整快取。
const CACHE = 'bkk-7655552a55';
const PRECACHE = ['./', 'index.html', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
const NETWORK_TIMEOUT = 5000;

function fetchWithTimeout(request, timeout = NETWORK_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return fetch(request, {signal: controller.signal}).then(async (response) => {
    // 預載時立刻讀完 body，避免未消耗的大頁面佔住連線，讓其他必要資源一直排隊。
    const bytes = await response.arrayBuffer();
    const headers = new Headers(response.headers);
    headers.delete('Content-Encoding'); headers.delete('Content-Length');
    return new Response(bytes.byteLength ? bytes : null, {status: response.status, headers});
  }).finally(() => clearTimeout(timer));
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    // 先取得完整一組資源，再寫入新快取；安裝失敗不接手、不刪舊版。
    const responses = await Promise.all(PRECACHE.map(async (name) => {
      const req = new Request(new URL(name, self.registration.scope), {cache: 'reload'});
      const res = await fetchWithTimeout(req, 30000);
      if (!res.ok) throw new Error('離線資源下載失敗');
      const type = res.headers.get('content-type') || '';
      if ((name.endsWith('.png') && !type.startsWith('image/')) ||
          (name.endsWith('.webmanifest') && !type.includes('json') && !type.includes('manifest'))) {
        throw new Error('離線資源格式不符');
      }
      return [req, res];
    }));
    const cache = await caches.open(CACHE);
    try {
      await Promise.all(responses.map(([req, res]) => cache.put(req, res)));
    } catch (err) {
      await caches.delete(CACHE);
      throw err;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  // 先接手並提示使用者重開；不要讓舊文件尚未釋放的快取串流阻塞啟用。
  e.waitUntil(self.clients.claim());
});

self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'BKK_CLEAN_OLD_CACHES' || e.data.cache !== CACHE) return;
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => /^bkk-[0-9a-f]{10}$/.test(k) && k !== CACHE).map((k) => caches.delete(k))
    ))
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  if (req.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  e.respondWith((async () => {
    let response;
    try {
      response = await fetchWithTimeout(req);
      if (response.ok) return response;
    } catch (_) {}
    // 只讀本版快取；其他 App 的同源快取不參與回退。
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, {ignoreSearch: true});
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const page = await cache.match(new URL('index.html', scope).href);
      if (page) return page;
    }
    // 圖示／manifest 缺少時絕不能回傳 HTML，避免錯把行程頁當成資源快取。
    return response || new Response('離線時無法取得此資源', {
      status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8'}
    });
  })());
});
