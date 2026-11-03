import { createRoot } from "react-dom/client";
import { Shell } from "./shell/Shell";
import "./styles.css";

// Projects, each with its Code view and its boards (web/shell/Shell.tsx).
createRoot(document.getElementById("root")!).render(<Shell />);

// Installable as an app. Production only: the dev server's modules aren't
// content-hashed, so caching them would serve stale code. Browsers only allow
// service workers on https or localhost; elsewhere this quietly does nothing.
if (import.meta.env.PROD && "serviceWorker" in navigator && window.isSecureContext) {
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
}
