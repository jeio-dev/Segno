import { claudeCodeAdapter } from "@segno/adapter-claude-code";
import type { AgentAdapter } from "@segno/core";
import {
  fakeAdapter,
  proposesFromRepo,
  writesFiles,
} from "@segno/engine/testing";
import { startHost } from "@segno/host";
import type { MessagePortMain } from "electron";

// The Engine host: an Electron utilityProcess running one Engine per Project [ADR-0037].
const appData = process.env.SEGNO_APP_DATA;
if (!appData) throw new Error("SEGNO_APP_DATA is not set for the Engine host.");

/**
 * The real Claude Code Adapter [ADR-0017]. S9 and hand demos opt in to the
 * fake one, paced so a live Run can be watched, which also reports usage.
 */
function adapters(): AgentAdapter[] {
  if (process.env.SEGNO_FAKE_ADAPTER !== "1") {
    const claude = claudeCodeAdapter();
    // detect() also learns whether the installed version reports usage.
    void claude.detect().catch(() => {});
    return [claude];
  }
  const coder = writesFiles();
  return [
    fakeAdapter(
      {
        async coder(run) {
          run.event({
            type: "usage",
            used: 37,
            limit: 100,
            resetAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
          });
          await run.output("Reading the Task.\n");
          await run.output("Planning the change.\n");
          return coder(run);
        },
        onboarding: proposesFromRepo(),
      },
      { paceMs: 700, usage: true },
    ),
  ];
}

const host = startHost({ appData, adapters: adapters() });

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
