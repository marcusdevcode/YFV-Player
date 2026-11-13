import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./theme/defaults.css";
import "./styles.css";

// Development only: a right-click shows the system menu (with "Inspect Element") instead of the app's own context menus.
// Hold Alt (Option) while right-clicking to get the app's own menu.
if (import.meta.env.DEV) {
  window.addEventListener("contextmenu", (e) => {
    if (!e.altKey) e.stopImmediatePropagation();
  }, true);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
