import "@fontsource/bricolage-grotesque/600.css";
import "@fontsource/bricolage-grotesque/800.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "../../../docs/design-tokens.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AppStore } from "./store.js";

const store = new AppStore(window.segno);
const root = document.getElementById("root");
if (!root) throw new Error("Missing #root.");
createRoot(root).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
