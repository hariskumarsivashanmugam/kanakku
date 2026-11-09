import { createApp } from "./app.js";
import { config } from "./config.js";
import { getSource } from "./data/index.js";

const app = createApp();
app.listen(config.port, () => {
  const mode = getSource().mode;
  console.log(`Kanakku server on http://localhost:${config.port}`);
  console.log(`  data: ${mode === "live" ? `PayPal sandbox (${config.paypal.baseUrl})` : "demo store (no PayPal keys needed)"}`);
  console.log(`  AI:   ${config.anthropicKey ? config.model : "ANTHROPIC_API_KEY missing — questions will fail until it is set"}`);
});
