import type { SegnoBridge } from "./bridge.js";

declare global {
  interface Window {
    segno: SegnoBridge;
  }
}
