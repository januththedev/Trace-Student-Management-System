import { describe, expect, it } from "vitest";
import {
  ageingBucket, collectionRate, computeInstalment, exemptionAmountFor, planAllocation, suggestInstalment, summarize, validateAllocation,
  LedgerInvariantError, type InstalmentFacts,
} from "@/domain/finance";
import { formatMinor, parseMajorToMinor, percentOf } from "@/lib/money";
import { businessDate, addDays } from "@/lib/time";

const f = (o: Partial<InstalmentFacts> & { id: string; dueDate: string }): InstalmentFacts => ({
  sequence: 1, periodLabel: o.id, component: "TUITION", originalChargeMinor: 1_000_000, adjustmentsMinor: 0, cancelledByAdjustment: false,
  exemptionsMinor: 0, allocatedMinor: 0, pendingClaimedMinor: 0, ...o,
});

describe("instalment states", () => {
  const today = "2026-11-15";
  it("due today is not overdue; yesterday is", () => {
    expect(computeInstalment(f({ id: "a", dueDate: today }), today).state).toBe("DUE_TODAY");
    expect(computeInstalment(f({ id: "a", dueDate: "2026-11-14" }), today).state).toBe("OVERDUE");
    expect(computeInstalment(f({ id: "a", dueDate: "2026-12-01" }), today).state).toBe("UPCOMING");
  });
  it("partial, paid, exempt, cancelled", () => {
    expect(computeInstalment(f({ id: "a", dueDate: "2026-12-01", allocatedMinor: 400_000 }), today).state).toBe("PARTIALLY_PAID");
    expect(computeInstalment(f({ id: "a", dueDate: "2026-10-01", allocatedMinor: 1_000_000 }), today).state).toBe("PAID");
    expect(computeInstalment(f({ id: "a", dueDate: "2026-10-01", exemptionsMinor: 1_000_000 }), today).state).toBe("EXEMPT");
    expect(computeInstalment(f({ id: "a", dueDate: "2026-12-01", adjustmentsMinor: -1_000_000, cancelledByAdjustment: true }), today).state).toBe("CANCELLED");
  });
  it("never hides bad accounting with clamping", () => {
    expect(() => computeInstalment(f({ id: "a", dueDate: today, allocatedMinor: 1_000_001 }), today)).toThrow(LedgerInvariantError);
    expect(() => computeInstalment(f({ id: "a", dueDate: today, exemptionsMinor: 1_000_001 }), today)).toThrow(LedgerInvariantError);
  });
});

describe("allocation", () => {
  const today = "2026-11-15";
  const views = [f({ id: "jan", sequence: 3, dueDate: "2027-01-05" }), f({ id: "nov", sequence: 1, dueDate: "2026-11-05", allocatedMinor: 400_000 }), f({ id: "dec", sequence: 2, dueDate: "2026-12-05" })].map((x) => computeInstalment(x, today));
  it("target first, excess to credit without spill-over", () => {
    expect(planAllocation(700_000, views, "nov", { spillOver: false })).toEqual({ lines: [{ instalmentId: "nov", amountMinor: 600_000 }], creditMinor: 100_000 });
  });
  it("spill-over fills earliest remaining obligations across a year boundary", () => {
    const p = planAllocation(2_000_000, views, "nov", { spillOver: true });
    expect(p.lines).toEqual([{ instalmentId: "nov", amountMinor: 600_000 }, { instalmentId: "dec", amountMinor: 1_000_000 }, { instalmentId: "jan", amountMinor: 400_000 }]);
    expect(p.creditMinor).toBe(0);
  });
  it("rejects reviewer lines beyond remaining or amount", () => {
    expect(() => validateAllocation(100, [{ instalmentId: "nov", amountMinor: 600_001 }], views)).toThrow();
    expect(() => validateAllocation(100, [{ instalmentId: "dec", amountMinor: 200 }], views)).toThrow();
    expect(() => validateAllocation(100, [{ instalmentId: "zzz", amountMinor: 1 }], views)).toThrow();
  });
  it("suggests earliest unpaid by due date then sequence", () => {
    expect(suggestInstalment(views)?.id).toBe("nov");
    const paid = views.map((v) => (v.id === "nov" ? { ...v, remainingMinor: 0 } : v));
    expect(suggestInstalment(paid)?.id).toBe("dec");
    expect(suggestInstalment([])).toBeNull();
  });
});

describe("summary, rate, ageing, exemptions", () => {
  it("credit = receipts - allocations; negative credit is an invariant error", () => {
    const v = [computeInstalment(f({ id: "a", dueDate: "2026-10-01", allocatedMinor: 1_000_000 }), "2026-11-15")];
    expect(summarize(v, 1_100_000, "2026-11-15").creditMinor).toBe(100_000);
    expect(() => summarize(v, 900_000, "2026-11-15")).toThrow(LedgerInvariantError);
  });
  it("collection rate excludes future obligations and handles zero denominator", () => {
    const v = [
      computeInstalment(f({ id: "past", dueDate: "2026-10-01", allocatedMinor: 500_000 }), "2026-11-15"),
      computeInstalment(f({ id: "future", dueDate: "2027-01-01", allocatedMinor: 1_000_000 }), "2026-11-15"),
    ];
    expect(collectionRate(v, "2026-11-15")).toEqual({ numerator: 500_000, denominator: 1_000_000, rate: 0.5 });
    expect(collectionRate(v, "2026-09-01").rate).toBeNull();
  });
  it("ageing buckets", () => {
    expect(ageingBucket("2026-11-15", "2026-11-15")).toBeNull();
    expect(ageingBucket("2026-11-14", "2026-11-15")).toBe("1-30");
    expect(ageingBucket("2026-10-15", "2026-11-15")).toBe("31-60");
    expect(ageingBucket("2026-08-01", "2026-11-15")).toBe("91+");
  });
  it("exemptions never exceed the charge and honour caps", () => {
    expect(exemptionAmountFor("PERCENT", 5000, 1_000_001, 0)).toBe(500_001);
    expect(exemptionAmountFor("FIXED", 2_000_000, 1_000_000, 300_000)).toBe(700_000);
    expect(exemptionAmountFor("PERCENT", 10000, 1_000_000, 0, 250_000)).toBe(250_000);
  });
});

describe("money and time", () => {
  it("parses and formats without floats", () => {
    expect(parseMajorToMinor("4,000.50")).toBe(400_050);
    expect(parseMajorToMinor("0.1")).toBe(10);
    expect(parseMajorToMinor("1.234")).toBeNull();
    expect(parseMajorToMinor("-5")).toBeNull();
    expect(formatMinor(1_100_000)).toBe("LKR 11,000.00");
    expect(percentOf(333, 5000)).toBe(167);
  });
  it("Colombo business date differs from UTC near midnight", () => {
    expect(businessDate(new Date("2026-11-14T19:00:00Z"))).toBe("2026-11-15"); // 00:30 Colombo
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});
