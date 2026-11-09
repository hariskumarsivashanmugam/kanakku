import { resolvedMode } from "../config.js";
import { DemoSource } from "./demoSource.js";
import { PayPalSource } from "./paypalSource.js";
import type { DataSource } from "./types.js";
import { WorkshopStore } from "./workshop.js";

let source: DataSource | null = null;

export function getSource(): DataSource {
  if (!source) source = resolvedMode() === "live" ? new PayPalSource() : new DemoSource();
  return source;
}

/** For tests: swap in a different source. */
export function setSource(s: DataSource) {
  source = s;
}

let workshop: WorkshopStore | null = null;

/** The artisans and jobs. Saved to disk when connected to PayPal, in memory for the demo store. */
export function getWorkshop(): WorkshopStore {
  if (!workshop) workshop = new WorkshopStore(getSource().mode === "live" && !process.env.KANAKKU_NO_PERSIST);
  return workshop;
}
