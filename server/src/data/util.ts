export const round2 = (n: number) => Math.round(n * 100) / 100;

export const todayISO = () => new Date().toISOString().slice(0, 10);

/** Whole days from date a to date b (YYYY-MM-DD or ISO). Positive when b is after a. */
export function daysBetween(a: string, b: string): number {
  const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((db - da) / 86_400_000);
}

export function addDays(iso: string, days: number) {
  return new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();
}
