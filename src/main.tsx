import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// 托盘菜单是独立小窗：index.html?view=tray-menu
const isTrayMenu = new URLSearchParams(window.location.search).get("view") === "tray-menu";

async function boot() {
  const root = document.getElementById("root")!;
  if (isTrayMenu) {
    const { trayMenu } = await import("./tray-menu");
    trayMenu(root);
  } else {
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  }
}

boot();
