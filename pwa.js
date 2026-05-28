/* Instalação como app (PWA): registra o service worker e, após 30s,
   mostra uma caixinha discreta para instalar. */
(function () {
  'use strict';

  // registra o service worker (habilita instalação + uso offline)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  var card = document.getElementById('install');
  if (!card) return;
  var btn = document.getElementById('install-btn');
  var closeBtn = document.getElementById('install-close');
  var hint = document.getElementById('install-hint');
  var KEY = 'ecossistema.pwa.dismissed';

  var deferred = null;
  var shown = false;

  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;

  function recentlyDismissed() {
    try {
      var t = +localStorage.getItem(KEY) || 0;
      return Date.now() - t < 14 * 86400000; // não insiste por 14 dias
    } catch (e) { return false; }
  }
  function remember() {
    try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {}
  }
  function hide() { card.classList.remove('show'); }
  function dismiss() { hide(); remember(); }

  function prepareInstallButton() {
    if (!btn) return;
    btn.style.display = '';
    if (hint) hint.textContent = 'instale como app · funciona offline';
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    if (shown) prepareInstallButton();
  });

  window.addEventListener('appinstalled', function () { hide(); remember(); });

  function show() {
    if (standalone || recentlyDismissed()) return;
    shown = true;
    if (isIOS) {
      if (btn) btn.style.display = 'none';
      if (hint) hint.innerHTML = 'para instalar: toque em <b>Compartilhar</b> e depois <b>Adicionar à Tela de Início</b>';
    } else if (deferred) {
      prepareInstallButton();
    } else {
      // navegador compatível mas sem prompt nativo disponível agora
      if (btn) btn.style.display = 'none';
      if (hint) hint.textContent = 'instale pelo menu do navegador → “instalar app”';
    }
    card.classList.add('show');
  }

  if (btn) btn.addEventListener('click', function () {
    if (!deferred) return;
    deferred.prompt();
    deferred.userChoice.then(function (choice) {
      deferred = null;
      if (choice && choice.outcome === 'accepted') hide();
      else dismiss();
    });
  });
  if (closeBtn) closeBtn.addEventListener('click', dismiss);

  setTimeout(show, 30000);
})();
