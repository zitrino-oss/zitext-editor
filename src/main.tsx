import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Expose the OS to CSS via a root `data-platform` attribute (alongside data-theme)
// so styles can target a single platform. Used for Linux/WebKitGTK-only tweaks
// where a rendering quirk (e.g. flat, shadowless cards) needs a different look
// without affecting Windows/macOS.
(() => {
    const ua = navigator.userAgent;
    const platform = /Mac OS X|Macintosh/i.test(ua)
        ? "macos"
        : /Linux/i.test(ua) && !/Android/i.test(ua)
            ? "linux"
            : /Windows/i.test(ua)
                ? "windows"
                : "other";
    document.documentElement.setAttribute("data-platform", platform);
})();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
