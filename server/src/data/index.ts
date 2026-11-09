import { resolvedMode } from "../config.js";
import { DemoSource } from "./demoSource.js";
import { PayPalSource } from "./paypalSource.js";
import type { DataSource } from "./types.js";

let source: DataSource | null = null;

export function getSource(): DataSource {
  if (!source) source = resolvedMode() === "live" ? new PayPalSource() : new DemoSource();
  return source;
}

/** For tests: swap in a different source. */
export function setSource(s: DataSource) {
  source = s;
}
