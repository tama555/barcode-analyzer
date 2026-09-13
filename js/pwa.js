/**
 * pwa.js - サービスワーカーの登録と更新通知
 *
 * 解析処理とは独立させてある。読み取りライブラリの読み込みに失敗しても、
 * オフライン起動と更新の仕組みだけは動くようにするため。
 */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  // file:// で開いた場合は登録できない。エラーを出さずに黙って諦める
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

  const banner = document.getElementById('updateBanner');
  const updateBtn = document.getElementById('updateBtn');
  const dismissBtn = document.getElementById('updateDismiss');

  let reloading = false;

  // 初回導入時もサービスワーカーが制御を取るが、それは更新ではないので
  // 再読み込みしない。既に制御下にあった場合だけ切り替えとみなす
  const hadController = !!navigator.serviceWorker.controller;

  /** 新しい版へ切り替わったら一度だけ再読み込みする */
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  function showBanner(registration) {
    if (!banner) return;
    banner.hidden = false;
    updateBtn.onclick = () => {
      updateBtn.disabled = true;
      updateBtn.textContent = '更新中…';
      if (registration.waiting) {
        registration.waiting.postMessage('SKIP_WAITING');
      } else {
        location.reload();
      }
    };
    if (dismissBtn) dismissBtn.onclick = () => { banner.hidden = true; };
  }

  /** 待機中の版があるか、これから入ってくるかを監視する */
  function watch(registration) {
    if (registration.waiting && navigator.serviceWorker.controller) {
      showBanner(registration);
    }
    registration.addEventListener('updatefound', () => {
      const incoming = registration.installing;
      if (!incoming) return;
      incoming.addEventListener('statechange', () => {
        // controller があるのは既に旧版で動いている場合。初回導入では通知しない
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
          showBanner(registration);
        }
      });
    });
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js')
      .then((registration) => {
        watch(registration);
        // 起動のたびに新しい版がないか確認する
        registration.update().catch(() => {});
      })
      .catch(() => {
        // 登録に失敗してもアプリ自体は動く。オフライン起動だけが使えない
      });
  });
})();
