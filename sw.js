// SyncClimb Service Worker
//
// [重要] index.html や manifest.json、アイコンを更新して再デプロイする際は、
// 必ず下の CACHE_NAME のバージョン番号を上げてください（例: 'synclimb-v1' -> 'synclimb-v2'）。
// これを忘れると、Service Worker が古いキャッシュを返し続け、
// 仲間のスマホにいつまでも新しい変更が反映されません。
const CACHE_NAME = 'synclimb-v3';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

// インストール時：アプリ本体一式をキャッシュに保存
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// 有効化時：古いバージョンのキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// リクエスト時：キャッシュ優先（オフライン対応）。
// キャッシュに無ければネットワークから取得し、可能なら次回用にキャッシュへ追加。
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // 動画ファイル本体（blob: / ローカルファイル選択）はキャッシュ対象外。
  // アプリの静的ファイル（HTML/JSON/画像）のみを対象にする。
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
