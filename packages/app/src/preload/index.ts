import type { hostPortMessage, SegnoBridge } from "@segno/ui";
import { contextBridge, ipcRenderer, webUtils } from "electron";

// A sandboxed preload can't load workspace modules, so only types are imported.
const portMessage: typeof hostPortMessage = "segno:host-port";

// Ports can't cross contextBridge, so they reach the page as a window message.
ipcRenderer.on("host:port", (event) => {
  window.postMessage(portMessage, "*", event.ports);
});

const bridge: SegnoBridge = {
  connect: () => ipcRenderer.send("host:connect"),
  onHostStatus(listener) {
    ipcRenderer.on("host:status", (_event, status) => listener(status));
  },
  restartHost: () => ipcRenderer.send("host:restart"),
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  pickPlanFile: () => ipcRenderer.invoke("dialog:pickPlanFile"),
  saveFile: (defaultName, text) =>
    ipcRenderer.invoke("dialog:saveFile", defaultName, text),
  pathForFile: (file) => webUtils.getPathForFile(file),
  setTheme: (theme) => ipcRenderer.send("theme:set", theme),
};
contextBridge.exposeInMainWorld("segno", bridge);
