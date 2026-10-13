import type { MessagePort } from "node:worker_threads";
import type { HostPort } from "@segno/core";

/** Adapts a Node `worker_threads` port, as used by S6. */
export function nodePort(port: MessagePort): HostPort {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => port.on("message", listener),
    onClose: (listener) => port.on("close", listener),
    close: () => port.close(),
  };
}
