import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, withTx } from "@/db/client";
import { auditEvents, staffAccounts, staffScopes } from "@/db/schema";
import type { StaffPrincipal } from "@/server/auth/policy";
import { exportReportData } from "@/server/services/reports/exports";
import { POST } from "@/app/api/staff/reports/export/route";
import { readPdf } from "../pdf-text";
import { closeDb, makeEnrolment, makeIntake, makeProgramme, makeStaff, makeStudent, pinNow, principalOf, resetDb, unpinNow } from "./helpers";

let principal: StaffPrincipal;
// Only the Next cookie/CSRF boundary is substituted; all scope, permission, data and audit checks use PostgreSQL.
vi.mock("@/server/auth/staff", () => ({ requireStaff: async () => principal }));
beforeEach(async () => { await resetDb(); pinNow("2026-06-15T06:30:00Z"); });
afterAll(async () => { unpinNow(); await closeDb(); });
async function fixture() {
  const programme = await makeProgramme();
  const intake = await makeIntake(programme.id);
  const student = await makeStudent({ fullName: "Visible PDF Student" });
  await makeEnrolment(student.id, intake.id, [{ amountMinor: 123_456, dueDate: "2026-06-01" }]);
  principal = principalOf(await makeStaff("ADMIN", { capabilities: ["exports.download"], scopes: [{ programmeId: programme.id }] }), [{ programmeId: programme.id }]);
  return { student };
}
async function request(body: Record<string, unknown>) {
  return POST(new NextRequest("http://localhost/api/staff/reports/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({}) });
}

describe("authorized PDF downloads", () => {
  it("downloads a private scoped PDF, masks NICs and audits the format", async () => {
    const { student } = await fixture();
    const hidden = await makeStudent({ fullName: "Hidden PDF Student" });
    await makeEnrolment(hidden.id, (await makeIntake((await makeProgramme()).id)).id, []);
    const response = await request({ report: "students", format: "pdf" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toMatch(/attachment; filename=".*\.pdf"/);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-row-count")).toBe("1");
    const text = (await readPdf(new Uint8Array(await response.arrayBuffer()))).map(p => p.text).join(" ");
    expect(text).toContain(student.fullName);
    expect(text).not.toContain(hidden.fullName);
    expect(text).not.toContain(student.nic);
    expect(text).toContain(student.nicMasked!);
    const events = await db().select().from(auditEvents).where(eq(auditEvents.action, "export.download"));
    expect(events).toHaveLength(1);
    expect(events[0].after).toMatchObject({ format: "pdf", rowCount: 1, fullIdentifiers: false });
    expect(JSON.stringify(events)).not.toContain(student.nic);
  });

  it("requires current capability, limits full identifiers to Super Admin, and retains CSV default", async () => {
    const { student } = await fixture();
    expect((await request({ report: "students", format: "pdf", fullIdentifiers: true })).status).toBe(403);
    const csv = await request({ report: "students" });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain(student.ref);
    await db().update(staffAccounts).set({ capabilities: [] }).where(eq(staffAccounts.id, principal.id));
    expect((await request({ report: "students", format: "pdf" })).status).toBe(403);
  });

  it("rechecks scope even with a stale principal and audits explicit full-NIC PDF requests", async () => {
    const { student } = await fixture();
    await db().delete(staffScopes).where(eq(staffScopes.staffId, principal.id));
    const scoped = await withTx(tx => exportReportData(tx, principal, { report: "students" }, { format: "pdf" }));
    expect(scoped.rowCount).toBe(0);
    principal = principalOf(await makeStaff("SUPER_ADMIN"));
    const response = await request({ report: "students", format: "pdf", fullIdentifiers: true });
    const text = (await readPdf(new Uint8Array(await response.arrayBuffer()))).map(p => p.text).join(" ");
    expect(text).toContain(student.nic);
    const [event] = await db().select().from(auditEvents).where(eq(auditEvents.action, "export.full_identifiers"));
    expect(event.after).toMatchObject({ format: "pdf", fullIdentifiers: true });
    expect(JSON.stringify(event)).not.toContain(student.nic);
  });

  it("validates format and dates before producing an export", async () => {
    await fixture();
    for (const body of [{ format: "html" }, { format: "pdf", from: "2026-02-30" }, { format: "pdf", from: "2026-06-15", to: "2026-06-01" }]) {
      expect((await request({ report: "students", ...body })).status).toBe(400);
    }
    expect(await db().select().from(auditEvents)).toHaveLength(0);
  });
});
