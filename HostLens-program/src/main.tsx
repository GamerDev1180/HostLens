import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";

// In a plain browser during development there's no Tauri backend, so load
// simulated data instead (see dev/browserPreview.ts).
const preview =
  import.meta.env.DEV && !("__TAURI_INTERNALS__" in window) ? import("./dev/browserPreview") : Promise.resolve();

preview.then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
