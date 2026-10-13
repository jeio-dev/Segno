import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { HostStatus } from "@segno/ui";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  nativeTheme,
  type UtilityProcess,
  utilityProcess,
} from "electron";

const here = import.meta.dirname;

/** SEGNO_APP_DATA, else the platform's data directory plus Segno [ADR-0048]. */
function resolveAppData() {
  if (process.env.SEGNO_APP_DATA) return process.env.SEGNO_APP_DATA;
  if (process.platform === "linux")
    return join(
      process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
      "Segno",
    );
  return join(app.getPath("appData"), "Segno");
}

const appData = resolveAppData();
// Chromium's own state, including the single-instance lock, stays under it.
app.setPath("userData", join(appData, "chromium"));

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  let window: BrowserWindow | undefined;
  let host: UtilityProcess | undefined;
  let hostReady = false;
  let lastDeath: number | undefined;
  let quitting = false;

  app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  function sendStatus(status: HostStatus) {
    window?.webContents.send("host:status", status);
  }

  /** Gives the window a fresh port to the current host. */
  function connectWindow() {
    if (!window || !host || !hostReady) return;
    const { port1, port2 } = new MessageChannelMain();
    host.postMessage({ type: "connect" }, [port1]);
    window.webContents.postMessage("host:port", null, [port2]);
  }

  function startHostProcess() {
    const child = utilityProcess.fork(join(here, "host.js"), [], {
      serviceName: "Segno Engine host",
      env: { ...process.env, SEGNO_APP_DATA: appData },
      stdio: "inherit",
    });
    host = child;
    hostReady = false;
    child.once("spawn", () => {
      hostReady = true;
      connectWindow();
      sendStatus("connected");
    });
    child.once("exit", () => {
      if (host !== child) return;
      host = undefined;
      hostReady = false;
      if (quitting) {
        app.quit();
        return;
      }
      // Restart once; a second death within 60 s needs the developer [ADR-0037].
      const now = Date.now();
      if (lastDeath !== undefined && now - lastDeath < 60_000) {
        sendStatus("failed");
        return;
      }
      lastDeath = now;
      sendStatus("reconnecting");
      startHostProcess();
    });
  }

  function createWindow() {
    window = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 600,
      title: "Segno",
      show: false,
      webPreferences: {
        preload: join(here, "../preload/index.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    window.once("ready-to-show", () => window?.show());
    window.on("closed", () => {
      window = undefined;
    });
    if (process.env.ELECTRON_RENDERER_URL)
      void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else void window.loadFile(join(here, "../renderer/index.html"));
  }

  ipcMain.on("host:connect", () => connectWindow());
  ipcMain.on("host:restart", () => {
    if (host) return;
    lastDeath = undefined;
    sendStatus("reconnecting");
    startHostProcess();
  });
  ipcMain.on("theme:set", (_event, theme: "system" | "light" | "dark") => {
    nativeTheme.themeSource = theme;
  });
  ipcMain.handle("dialog:pickFolder", async () => {
    const options = { properties: ["openDirectory" as const] };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("dialog:pickPlanFile", async () => {
    const options = {
      properties: ["openFile" as const],
      filters: [{ name: "Plan files", extensions: ["yaml", "yml"] }],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    if (![".yaml", ".yml"].includes(extname(path)))
      return { path, error: "Plan files must be .yaml or .yml." };
    try {
      const bytes = await readFile(path);
      const yaml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { path, yaml };
    } catch (error) {
      return {
        path,
        error: `Couldn't read ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
  ipcMain.handle(
    "dialog:saveFile",
    async (_event, defaultName: string, text: string) => {
      const options = { defaultPath: defaultName };
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return false;
      await writeFile(result.filePath, text);
      return true;
    },
  );

  // Until the tray arrives in B8, closing the window quits the app.
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (!host) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    // Quit shuts every Engine down; the host exits once they're closed.
    host.postMessage({ type: "shutdown" });
    setTimeout(() => host?.kill(), 5_000).unref();
  });

  void app.whenReady().then(() => {
    createWindow();
    startHostProcess();
  });
}
