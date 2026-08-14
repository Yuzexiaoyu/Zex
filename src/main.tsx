import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// 独立小窗都走同一个 index.html，用 ?view= 区分：tray-menu=托盘菜单、desktop-lyrics=桌面歌词
const view = new URLSearchParams(window.location.search).get("view");

async function boot() {
  const root = document.getElementById("root")!;
  if (view === "tray-menu") {
    const { trayMenu } = await import("./tray-menu");
    trayMenu(root);
  } else if (view === "desktop-lyrics") {
    const { desktopLyrics } = await import("./desktop-lyrics");
    desktopLyrics(root);
  } else {
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  }
}

boot();
