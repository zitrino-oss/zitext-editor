// Applies the saved/OS theme before first paint to avoid a flash of the wrong
// theme (notably the white WebView2 default on Windows). Kept as a small,
// self-hosted classic script loaded in <head> so it runs before the body
// renders and is allowed under a strict `script-src 'self'` CSP without relying
// on an inline-script hash.
(function () {
  try {
    var t = localStorage.getItem('zitext_theme');
    if (t !== 'light' && t !== 'dark') {
      // Follow the OS on a fresh install; fall back to dark if matchMedia is
      // unavailable (keeps the anti-white-flash behavior).
      t = (!window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', t);
  } catch (_) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
