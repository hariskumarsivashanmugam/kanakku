import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { addDays } from "./util.js";

/**
 * The workshop: the artisans who make Meena Prints' goods and the jobs scheduled with them.
 * This is the shop's own data (PayPal has no concept of it), so it lives in Kanakku: in memory for the demo
 * store, and in .kanakku/workshop.json when connected to a PayPal sandbox. Paying an artisan goes through
 * PayPal Payouts.
 */

export interface Artisan {
  id: string;
  name: string;
  craft: string;
  place: string;
  email: string; // PayPal email the payout goes to
}

export type JobStatus = "planned" | "in_progress" | "done" | "paid";

export interface Job {
  id: string;
  artisanId: string;
  title: string;
  customer?: string;
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD (exclusive end, like a calendar)
  pay: number;
  currency: string;
  status: JobStatus;
  completedAt?: string;
  payout?: { batchId: string; status: string; paidAt: string; actionId?: string };
}

export interface WorkshopData {
  artisans: Artisan[];
  jobs: Job[];
}

const day = (offset: number) => addDays(new Date().toISOString(), offset).slice(0, 10);

export function defaultWorkshop(): WorkshopData {
  const emails = (process.env.ARTISAN_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const artisans: Artisan[] = [
    { id: "a1", name: "Selvi Murugan", craft: "Handloom weaving", place: "Coimbatore", email: emails[0] ?? "selvi.murugan@example.com" },
    { id: "a2", name: "Fatima Khatri", craft: "Ajrakh printing", place: "Ajrakhpur, Kutch", email: emails[1] ?? "fatima.khatri@example.com" },
    { id: "a3", name: "Ramesh Naidu", craft: "Kalamkari painting", place: "Srikalahasti", email: emails[2] ?? "ramesh.naidu@example.com" },
    { id: "a4", name: "Arjun Pillai", craft: "Indigo dyeing", place: "Puducherry", email: emails[3] ?? "arjun.pillai@example.com" },
    { id: "a5", name: "Kamala Devi", craft: "Block printing", place: "Bagru", email: emails[4] ?? "kamala.devi@example.com" },
  ];
  const j = (artisanId: string, title: string, customer: string | undefined, s: number, e: number, pay: number, status: JobStatus, paidDaysAgo?: number): Job => ({
    id: "job_" + randomUUID().slice(0, 8),
    artisanId,
    title,
    customer,
    start: day(s),
    end: day(e),
    pay,
    currency: "USD",
    status,
    completedAt: status === "done" || status === "paid" ? addDays(new Date().toISOString(), Math.min(e, 0) - 1) : undefined,
    payout:
      status === "paid"
        ? { batchId: "DEMO-" + randomUUID().slice(0, 8).toUpperCase(), status: "SUCCESS", paidAt: addDays(new Date().toISOString(), -(paidDaysAgo ?? 3)) }
        : undefined,
  });
  return {
    artisans,
    jobs: [
      // Paid last month
      j("a3", "Kalamkari scarves ×20 for Juniper & Thread", "Juniper & Thread", -30, -20, 140, "paid", 18),
      j("a1", "Cotton sarees ×12 for Nordic Loom", "Nordic Loom Co.", -26, -14, 300, "paid", 12),
      // Finished, waiting to be paid
      j("a2", "Ajrakh stoles ×12 for Casa Lino", "Casa Lino", -12, -2, 180, "done"),
      j("a5", "Block-print totes ×30 for Maple Street", "Maple Street Living", -9, -1, 90, "done"),
      // In progress now
      j("a4", "Indigo cushion covers ×25 (new fast-dye batch)", "Casa Lino", -5, 4, 125, "in_progress"),
      j("a1", "Cotton sarees ×8 for The Indigo Room", "The Indigo Room", -3, 8, 200, "in_progress"),
      j("a3", "Kalamkari scarves ×15 for online shop", undefined, -2, 5, 105, "in_progress"),
      // Coming up
      j("a2", "Ajrakh stoles ×15 for Juniper & Thread", "Juniper & Thread", 3, 12, 225, "planned"),
      j("a5", "Table runners ×18 for Casa Lino", "Casa Lino", 6, 13, 108, "planned"),
      j("a4", "Indigo dye lot for saree borders", undefined, 7, 10, 60, "planned"),
      j("a1", "Diwali saree restock ×10", undefined, 10, 22, 250, "planned"),
    ],
  };
}

/** Where the live workshop is saved. Demo mode keeps it in memory. */
const file = process.env.KANAKKU_WORKSHOP || path.join(process.env.KANAKKU_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.kanakku"), "workshop.json");

export class WorkshopStore {
  private data: WorkshopData;
  constructor(private persist: boolean) {
    this.data = persist ? this.load() : defaultWorkshop();
  }

  private load(): WorkshopData {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      const d = defaultWorkshop();
      this.write(d);
      return d;
    }
  }

  private write(d: WorkshopData) {
    if (!this.persist) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(d, null, 2));
  }

  save() {
    this.write(this.data);
  }

  reset() {
    this.data = defaultWorkshop();
    this.save();
  }

  get(): WorkshopData {
    return structuredClone(this.data);
  }

  artisan(id: string) {
    return this.data.artisans.find((a) => a.id === id || a.name.toLowerCase() === id.toLowerCase());
  }

  job(id: string) {
    return this.data.jobs.find((j) => j.id === id);
  }

  createJob(input: Omit<Job, "id" | "status" | "currency"> & { currency?: string; status?: JobStatus }) {
    if (!this.artisan(input.artisanId)) throw new Error(`No artisan ${input.artisanId}`);
    if (input.end <= input.start) throw new Error("A job has to end after it starts.");
    if (!(input.pay >= 0)) throw new Error("Pay can't be negative.");
    const job: Job = { currency: "USD", status: "planned", ...input, artisanId: this.artisan(input.artisanId)!.id, id: "job_" + randomUUID().slice(0, 8) };
    this.data.jobs.push(job);
    this.save();
    return job;
  }

  updateJob(id: string, patch: Partial<Pick<Job, "start" | "end" | "artisanId" | "status" | "title" | "pay">>) {
    const job = this.job(id);
    if (!job) throw new Error(`No job ${id}`);
    if (job.status === "paid" && (patch.start || patch.end || patch.artisanId || patch.pay !== undefined || patch.status)) {
      throw new Error("This job has already been paid, so it can't be changed.");
    }
    if (patch.status === "paid") throw new Error("Jobs are marked paid only by a PayPal payout.");
    if (patch.artisanId) {
      const a = this.artisan(patch.artisanId);
      if (!a) throw new Error(`No artisan ${patch.artisanId}`);
      patch.artisanId = a.id;
    }
    const next = { ...job, ...patch };
    if (next.end <= next.start) throw new Error("A job has to end after it starts.");
    if (patch.status === "done" && job.status !== "done") next.completedAt = new Date().toISOString();
    if (patch.status && patch.status !== "done") next.completedAt = undefined;
    Object.assign(job, next);
    this.save();
    return job;
  }

  markPaid(id: string, payout: Job["payout"]) {
    const job = this.job(id);
    if (!job) throw new Error(`No job ${id}`);
    job.status = "paid";
    job.payout = payout;
    this.save();
    return job;
  }

  setPayoutStatus(id: string, status: string) {
    const job = this.job(id);
    if (job?.payout && job.payout.status !== status) {
      job.payout.status = status;
      this.save();
    }
  }
}
