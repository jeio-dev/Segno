import { startHost } from "@segno/host";
import type { MessagePortMain } from "electron";

// The Engine host: an Electron utilityProcess running one Engine per Project [ADR-0037].
const appData = process.env.SEGNO_APP_DATA;
if (!appData) throw new Error("SEGNO_APP_DATA is not set for the Engine host.");
const host = startHost({ appData, adapters: [] });

function mainPort(port: MessagePortMain) {
  return {
    postMessage: (message: unknown) => port.postMessage(message),
    onMessage(listener: (message: unknown) => void) {
      port.on("message", (event) => listener(event.data));
      port.start();
    },
    onClose: (listener: () => void) => port.on("close", listener),
    close: () => port.close(),
  };
}

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  void host.close().then(() => process.exit(0));
}

process.parentPort.on("message", (event) => {
  const { type } = (event.data ?? {}) as { type?: string };
  const [port] = event.ports;
  if (type === "connect" && port) host.connect(mainPort(port));
  else if (type === "shutdown") shutdown();
});
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
