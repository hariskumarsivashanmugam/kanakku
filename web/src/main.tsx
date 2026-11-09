import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ModuleRegistry as GridModules, AllCommunityModule as GridAll } from "ag-grid-community";
import { ModuleRegistry as ChartModules, AllCommunityModule as ChartAll } from "ag-charts-community";
import App from "./App";
import "./styles.css";

GridModules.registerModules([GridAll]);
ChartModules.registerModules([ChartAll]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
