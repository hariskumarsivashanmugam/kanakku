import { useEffect, useState } from "react";

export type Page = "overview" | "sales" | "invoices" | "disputes" | "activity";
const PAGES: Page[] = ["overview", "sales", "invoices", "disputes", "activity"];

function parse(): { page: Page; arg: string | null } {
  const [p, arg] = window.location.hash.replace(/^#\/?/, "").split("/");
  return { page: (PAGES as string[]).includes(p) ? (p as Page) : "overview", arg: arg ? decodeURIComponent(arg) : null };
}

export function navigate(page: Page, arg?: string) {
  window.location.hash = `/${page}${arg ? `/${encodeURIComponent(arg)}` : ""}`;
}

/** Tiny hash router: #/invoices/overdue → { page: "invoices", arg: "overdue" }. */
export function useRoute() {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => {
      setRoute(parse());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
