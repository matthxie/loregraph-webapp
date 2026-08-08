import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installGraphClient } from "./lib/graphClient";
import "./styles/styles.css";

installGraphClient();

// Stray drops outside the composer would navigate the tab to the dropped file.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
