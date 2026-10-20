import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);

// Installable as an app. Production only: the dev server's modules aren't
// content-hashed, so caching them would serve stale code. Browsers only allow
// service workers on https or localhost; elsewhere this quietly does nothing.
if (import.meta.env.PROD && "serviceWorker" in navigator && window.isSecureContext) {
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
}
