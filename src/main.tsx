import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./theme/defaults.css";
import "./styles.css";

// The system's right-click menu is never shown: the app has its own context menus (where there is none, a right-click does nothing).
// In development the web inspector is opened from the Dev menu (Dev -> Open Inspector, Cmd/Ctrl+Alt+I).
// (Capture phase, so nothing in the page can let the system menu through; the app's own menus still open from their handlers.)
window.addEventListener("contextmenu", (e) => e.preventDefault(), true);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
