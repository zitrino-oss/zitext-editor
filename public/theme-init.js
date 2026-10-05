// Applies the saved/OS theme before first paint to avoid a flash of the wrong
// theme (notably the white WebView2 default on Windows). Kept as a small,
// self-hosted classic script loaded in <head> so it runs before the body
// renders and is allowed under a strict `script-src 'self'` CSP without relying
// on an inline-script hash.
//
// localStorage holds the *preference*, which may be 'system'. Anything that is
// not an explicit 'light' or 'dark' — including 'system', a missing key on a
// fresh install, or a corrupt value — resolves against the OS here, so the
// first paint matches what React will settle on a moment later.
(function () {
  try {
    var t = localStorage.getItem('zitext_theme');
    if (t !== 'light' && t !== 'dark') {
      // Fall back to dark if matchMedia is unavailable (keeps the
      // anti-white-flash behavior).
      t = (!window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', t);
  } catch (_) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
