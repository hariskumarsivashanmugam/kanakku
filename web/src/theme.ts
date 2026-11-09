import { useEffect, useMemo, useState } from "react";
import { themeQuartz } from "ag-grid-community";

export function useDarkMode() {
  const q = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => window.matchMedia?.(q).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(q);
    if (!mq) return;
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return dark;
}

export const palettes = {
  light: { ink: "#1F2A55", muted: "#5B6177", line: "#DCDFEA", surface: "#FFFFFF", head: "#F3F4F8", indigo: "#2D3E8C", madder: "#C2412F", turmeric: "#D99A1E", ok: "#2F7A4F" },
  dark: { ink: "#E6E8F2", muted: "#A3A8BE", line: "#2E3658", surface: "#1A2142", head: "#202850", indigo: "#8C9CF0", madder: "#F07A63", turmeric: "#F2C14E", ok: "#6FCF97" },
};

export function usePalette() {
  return useDarkMode() ? palettes.dark : palettes.light;
}

export function useGridTheme() {
  const dark = useDarkMode();
  return useMemo(() => {
    const p = dark ? palettes.dark : palettes.light;
    return themeQuartz.withParams({
      fontFamily: "inherit",
      fontSize: 14,
      foregroundColor: p.ink,
      backgroundColor: p.surface,
      headerBackgroundColor: p.head,
      headerTextColor: p.ink,
      borderColor: p.line,
      accentColor: p.indigo,
      oddRowBackgroundColor: "transparent",
      rowHoverColor: dark ? "#252E5A" : "#F6F7FB",
      selectedRowBackgroundColor: dark ? "#2A3470" : "#E9ECF8",
      wrapperBorderRadius: 8,
      headerFontWeight: 600,
      rowHeight: 44,
      headerHeight: 42,
    });
  }, [dark]);
}

/** Shared chart styling so every chart reads as one system. */
export function chartBase(p: (typeof palettes)["light"]) {
  return {
    background: { fill: "transparent" },
    padding: { top: 8, right: 8, bottom: 4, left: 4 },
    theme: {
      params: { fontFamily: "Anek Latin, Anek Tamil, Anek Devanagari, sans-serif" },
      overrides: {
        common: {
          legend: { item: { label: { color: p.muted } } },
          axes: {
            category: { label: { color: p.muted }, line: { stroke: p.line } },
            time: { label: { color: p.muted }, line: { stroke: p.line } },
            number: { label: { color: p.muted }, gridLine: { style: [{ stroke: p.line }] } },
          },
        },
      },
    },
  };
}
