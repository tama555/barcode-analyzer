/**
 * service-worker.js - オフライン起動と更新管理
 *
 * 方針:
 *  - インストール時にアプリ一式を保存する。以降は端末内から起動する。
 *  - 取得はキャッシュ優先。ネットワークは保存されていないものだけ見に行く。
 *  - 新しい版が来ても勝手に切り替えない。画面側の「更新する」操作を待つ。
 *    黙って入れ替えると、解析中に中身が変わって混乱するため。
 *
 * ファイルを足したり減らしたりしたら CACHE_NAME の版数を上げること。
 */
const CACHE_NAME = 'barcode-analyzer-v9';

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/data.js',
  './js/generate.js',
  './js/analyzer.js',
  './js/settings.js',
  './js/render.js',
  './js/app.js',
  './js/pwa.js',
  './vendor/zxing.umd.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // cache: 'reload' を付けないとブラウザの通常キャッシュにある古い版を
      // そのまま保存してしまい、更新したはずのファイルが反映されない
      cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // ページ遷移はネットワークを先に試し、圏外なら保存済みの index.html を返す
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html', { ignoreSearch: true }))
    );
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        // 取得できた同一オリジンのものは次回のために保存しておく
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});

// 画面側で「更新する」が押されたら、待機中の新しい版へ切り替える
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
