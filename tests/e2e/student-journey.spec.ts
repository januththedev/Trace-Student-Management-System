import { expect, test } from "@playwright/test";
import { chooseIntake, enterStudent, expireSession, openReview, seedStudent, signInStaff, tabTo, uploadReceipt } from "./support";

test("entry matches NIC plus course immediately without OTP or password", async ({ page }) => {
  const f = await seedStudent();
  await enterStudent(page, f);
  await expect(page.getByRole("heading", { name: "Receipt history", exact: true })).toBeVisible();
  await expect(page.getByLabel(/password|OTP|verification code/i)).toHaveCount(0);
});

test("unknown NIC shows the exact neutral eligibility message", async ({ page }) => {
  const f = await seedStudent();
  await page.goto("/");
  await chooseIntake(page, "Course and intake", f);
  await page.getByLabel("NIC number", { exact: true }).fill("200012345678");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "We could not find" })).toHaveText("We could not find an eligible enrolment.");
  await expect(page).toHaveURL(/\/$/);
});

test("upload survives reload, keeps the suggested instalment and separates pending from approved money", async ({ page }) => {
  const f = await seedStudent();
  await enterStudent(page, f);
  await uploadReceipt(page, f);
  await page.reload();
  const history = page.getByRole("region", { name: "Receipt history" });
  await expect(history.getByText("Under review", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Instalment you paid for", exact: true })).toContainText("December tuition");
  await expect(page.getByText(/is still under review\. It is not counted as paid yet/)).toBeVisible();
  const data = await (await page.request.get("/api/student/submissions")).json();
  expect(data.ledger.summary).toMatchObject({ pendingClaimedMinor: 400_000, approvedAllocatedMinor: 0, outstandingMinor: 1_000_000 });
});

test("student upload to staff approval, follow-up balance, and undo back to review", async ({ page, context }) => {
  const f = await seedStudent();
  await enterStudent(page, f);
  await uploadReceipt(page, f);
  const staff = await context.newPage();
  await signInStaff(staff);
  await openReview(staff, f);
  await staff.getByRole("button", { name: /^Approve(?: \(A\)|…)?$/ }).click();
  await expect(staff.getByLabel("Confirmed amount (LKR)", { exact: true })).toHaveValue("4000.00");
  await staff.getByRole("button", { name: /^Confirm approve/ }).click();
  await expect(staff.getByRole("button", { name: /^Undo \(/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Receipt history" }).getByText("Approved", { exact: true })).toBeVisible();
  const approved = await (await page.request.get("/api/student/submissions")).json();
  expect(approved.ledger.summary).toMatchObject({ pendingClaimedMinor: 0, approvedAllocatedMinor: 400_000, outstandingMinor: 600_000 });
  const review = staff.url();
  const calls = await staff.request.get(`/api/staff/calls/${f.enrolmentId}`);
  expect(calls.ok()).toBe(true);
  expect((await calls.json()).dueInstalments[0].remainingMinor).toBe(600_000);
  // Keep the approval panel mounted so quick undo uses its real action id.
  expect(staff.url()).toBe(review);
  await staff.getByRole("button", { name: /^Undo \(/ }).click();
  await expect(staff.getByRole("img", { name: `Receipt from ${f.name}`, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Receipt history" }).getByText("Under review", { exact: true })).toBeVisible();
  const undone = await (await page.request.get("/api/student/submissions")).json();
  expect(undone.ledger.summary).toMatchObject({ pendingClaimedMinor: 400_000, approvedAllocatedMinor: 0, outstandingMinor: 1_000_000 });
});

test("reject requires a reason and preserves the student's pending receipt on an empty reason", async ({ page, context }) => {
  const f = await seedStudent();
  await enterStudent(page, f);
  await uploadReceipt(page, f);
  const staff = await context.newPage();
  await signInStaff(staff);
  await openReview(staff, f);
  await staff.getByRole("button", { name: /^Reject(?: \(R\)|…)?$/ }).click();
  await expect(staff.getByLabel("Reason shown to the student", { exact: true })).toBeVisible();
  await staff.getByRole("button", { name: "Confirm reject", exact: true }).click();
  await expect(staff.getByRole("alert").filter({ hasText: "A reason is required" })).toContainText("A reason is required. The student will see it.");
  expect((await (await page.request.get("/api/student/submissions")).json()).submissions[0].status).toBe("PENDING_REVIEW");
});

test("skipping a receipt preserves pending counts, evidence and money across reload", async ({ page, context }) => {
  const f = await seedStudent();
  await enterStudent(page, f);
  const submissionId = await uploadReceipt(page, f);
  const staff = await context.newPage();
  await signInStaff(staff);
  await openReview(staff, f);
  const queueUrl = `/api/staff/review/queue?intakeId=${f.intakeId}`;
  const before = await (await staff.request.get(queueUrl)).json();
  const original = await (await staff.request.get(`/api/staff/review/${submissionId}/context`)).json();
  expect(before.items.map((item: { id: string }) => item.id)).toEqual([submissionId]);

  await staff.getByRole("button", { name: /^Skip(?: \(S\))?$/ }).click();
  await expect(staff.getByText("No pending receipts match this view.", { exact: true })).toBeVisible();
  await expect(staff.getByText(`${before.totalPending} pending in scope · 1 skipped this session`, { exact: true })).toBeVisible();
  await staff.reload();
  await expect(staff.getByText("No pending receipts match this view.", { exact: true })).toBeVisible();
  await expect(staff.getByText(`${before.totalPending} pending in scope · 1 skipped this session`, { exact: true })).toBeVisible();

  const after = await (await staff.request.get(queueUrl)).json();
  expect(after.totalPending).toBe(before.totalPending);
  expect(after.items.map((item: { id: string }) => item.id)).toEqual([submissionId]);
  const unchanged = await (await staff.request.get(`/api/staff/review/${submissionId}/context`)).json();
  // Leaving a card releases its advisory lease; every business field must stay unchanged.
  const businessFields = (submission: Record<string, unknown>) => {
    const fields = { ...submission };
    delete fields.leaseHolder;
    delete fields.leaseExpiresAt;
    return fields;
  };
  expect(businessFields(unchanged.submission)).toEqual(businessFields(original.submission));
  expect(unchanged.actions).toEqual(original.actions);
  expect(unchanged.ledger).toEqual(original.ledger);
  expect((await staff.request.get(`/api/staff/review/${submissionId}/evidence`)).ok()).toBe(true);

  await staff.getByRole("button", { name: "Show skipped again", exact: true }).click();
  await expect(staff.getByRole("img", { name: `Receipt from ${f.name}`, exact: true })).toBeVisible();
  await expect(staff.getByText(`${before.totalPending} pending in scope`, { exact: true })).toBeVisible();
  await expect(staff.getByRole("button", { name: "Show skipped again", exact: true })).toHaveCount(0);
  await page.reload();
  const student = await (await page.request.get("/api/student/submissions")).json();
  expect(student.submissions[0].status).toBe("PENDING_REVIEW");
  expect(student.ledger.summary).toMatchObject({ pendingClaimedMinor: 400_000, approvedAllocatedMinor: 0, outstandingMinor: 1_000_000 });
});

test("remembered masked suggestion works; forget revokes it; logout and Back hide financial data", async ({ page }) => {
  const f = await seedStudent();
  await enterStudent(page, f, true);
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("Continue as", { exact: true })).toBeVisible();
  await expect(page.getByLabel("NIC number", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
  await page.getByRole("button", { name: "Forget this device", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("Continue as", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("NIC number", { exact: true })).toHaveValue("");
  expect((await page.context().cookies()).some((c) => c.name === "t2t_device" || c.name === "t2t_student")).toBe(false);
  expect((await page.request.get("/api/student/submissions")).status()).toBe(401);
  await enterStudent(page, f);
  await page.goto("/me?navigation=back-check");
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(page.getByRole("heading", { name: f.name, exact: true })).toHaveCount(0);
  await expect(page.getByLabel("NIC number", { exact: true })).toBeVisible();
});

test("private pages, financial JSON and evidence are no-store and browser stores contain no raw NIC", async ({ page, context }) => {
  const f = await seedStudent();
  await enterStudent(page, f, true);
  // The app auto-registers only in production. Exercise the actual worker in dev too.
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  });
  const submissionId = await uploadReceipt(page, f);
  for (const url of ["/me", "/api/student/submissions", `/api/student/submissions/${submissionId}/evidence`, `/api/student/submissions/${submissionId}/evidence?v=original`]) {
    const response = await page.request.get(url);
    expect(response.ok(), url).toBe(true);
    expect(response.headers()["cache-control"], url).toContain("no-store");
  }
  const stored = await page.evaluate(async () => ({ local: { ...localStorage }, session: { ...sessionStorage }, caches: await Promise.all((await caches.keys()).map(async (key) => ({ key, urls: (await (await caches.open(key)).keys()).map((r) => r.url) }))) }));
  expect(JSON.stringify(stored)).not.toContain(f.nic);
  expect(stored.caches.length).toBeGreaterThan(0);
  for (const cache of stored.caches) expect(cache.urls.some((url) => /\/me(?:\?|$)|\/staff|\/api\/(student|staff)/.test(url))).toBe(false);
  const cookies = await context.cookies();
  expect(JSON.stringify(cookies)).not.toContain(f.nic);
  expect(cookies.find((c) => c.name === "t2t_device")?.httpOnly).toBe(true);
  const staff = await context.newPage();
  await signInStaff(staff);
  for (const url of ["/staff", "/staff/review", "/api/staff/review/queue", `/api/staff/review/${submissionId}/evidence`]) {
    const response = await staff.request.get(url);
    expect(response.ok(), url).toBe(true);
    expect(response.headers()["cache-control"], url).toContain("no-store");
  }
});

test("entry and review approval complete using keyboard with accessible labels and reduced motion", async ({ page, context }) => {
  const f = await seedStudent();
  await page.goto("/");
  await tabTo(page, page.getByLabel("Course and intake"));
  // Open the actual Radix list and choose this intake using only keyboard input.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Home");
  const targetOption = page.getByRole("option").filter({ hasText: f.intakeLabel });
  await expect(targetOption).toHaveCount(1);
  const optionCount = await page.getByRole("option").count();
  for (let i = 0; i < optionCount; i++) {
    if (await targetOption.evaluate(el => el === document.activeElement)) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(targetOption).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox", { name: "Course and intake", exact: true })).toContainText(f.intakeLabel);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("NIC number", { exact: true })).toBeFocused();
  await page.keyboard.type(f.nic);
  await tabTo(page, page.getByRole("button", { name: "Continue", exact: true }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/me$/);
  await uploadReceipt(page, f);
  const staff = await context.newPage();
  await signInStaff(staff);
  await openReview(staff, f);
  await tabTo(staff, staff.getByRole("button", { name: /^Approve(?: \(A\)|…)?$/ }));
  await staff.keyboard.press("Enter");
  await expect(staff.getByLabel("Confirmed amount (LKR)", { exact: true })).toBeFocused();
  await tabTo(staff, staff.getByRole("button", { name: /^Confirm approve/ }));
  await staff.keyboard.press("Enter");
  await expect(staff.getByRole("button", { name: /^Undo \(/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("expired sessions block upload and return the student to entry", async ({ page, context }) => {
  const f = await seedStudent();
  await enterStudent(page, f);
  const token = (await context.cookies()).find((cookie) => cookie.name === "t2t_student")!.value;
  await expireSession(token);
  const response = await page.request.get("/api/student/submissions");
  expect(response.status()).toBe(401);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const upload = await page.request.post("/api/student/uploads", { data: { mime: "image/png", sizeBytes: 100 } });
  expect(upload.status()).toBe(401);
  await page.reload();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: f.name, exact: true })).toHaveCount(0);
});

test("main student-to-review-to-follow-up journey records a real call outcome without changing money", async ({ page, context }) => {
  const f = await seedStudent();
  await enterStudent(page, f);
  await uploadReceipt(page, f);
  const staff = await context.newPage();
  await signInStaff(staff);
  await openReview(staff, f);
  await staff.getByRole("button", { name: /^Approve(?: \(A\)|…)?$/ }).click();
  await staff.getByRole("button", { name: /^Confirm approve/ }).click();
  await expect(staff.getByRole("button", { name: /^Undo \(/ })).toBeVisible();
  await staff.goto("/staff/calls");
  // App Router can finish the initial document before the streamed queue is ready.
  await expect(staff.getByRole("region", { name: "Enrolment call queue", exact: true })).toBeVisible();
  const queuePicker = staff.getByRole("combobox", { name: "Enrolment call queue", exact: true });
  let selected = false;
  // The suite creates more than one keyset batch. Use the same paging controls as staff
  // instead of assuming this randomly generated enrolment sorts into the first batch.
  for (let batch = 0; batch < 10 && !selected; batch++) {
    if (await queuePicker.isVisible()) {
      await queuePicker.click();
      const option = staff.getByRole("option").filter({ hasText: f.name });
      if (await option.count()) { await option.click(); selected = true; break; }
      await staff.keyboard.press("Escape");
    } else {
      const card = staff.getByRole("button", { name: new RegExp(f.name) });
      if (await card.isVisible()) { await card.click(); selected = true; break; }
    }
    const more = staff.getByRole("button", { name: "Load more enrolments", exact: true });
    await expect(more, "The eligible enrolment must remain reachable through queue pagination").toBeVisible();
    const nextBatch = staff.waitForResponse(r => r.url().includes("/api/staff/calls?cursor="));
    await more.click();
    expect((await nextBatch).status()).toBe(200);
    await expect(staff.getByRole("region", { name: "Selected enrolment", exact: true })).toHaveAttribute("aria-busy", "false");
  }
  expect(selected).toBe(true);
  await expect(staff.getByRole("heading", { name: f.name, exact: true })).toBeVisible();
  await staff.getByRole("button", { name: "No answer", exact: true }).click();
  const form = staff.getByRole("form", { name: "No answer outcome", exact: true });
  await form.getByLabel("Notes", { exact: true }).fill("Synthetic acceptance call: no answer.");
  await form.getByLabel("Manual contact override reason (only when needed)", { exact: true }).fill("Synthetic acceptance run outside normal contact hours.");
  await form.getByRole("button", { name: "Save outcome", exact: true }).click();
  await expect(staff.getByText("Outcome saved.", { exact: true })).toBeVisible();
  await staff.getByRole("button", { name: "Done and refresh", exact: true }).click();
  await expect(staff.getByText("Synthetic acceptance call: no answer.", { exact: true })).toBeVisible();
  const card = await (await staff.request.get(`/api/staff/calls/${f.enrolmentId}`)).json();
  expect(card.contactHistory).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "NO_ANSWER" })]));
  expect(card.openTasks).toEqual(expect.arrayContaining([expect.objectContaining({ type: "COLLECTION_CALL", state: "OPEN" })]));
  await page.reload();
  expect((await (await page.request.get("/api/student/submissions")).json()).ledger.summary).toMatchObject({ approvedAllocatedMinor: 400_000, outstandingMinor: 600_000 });
});

test("entry and upload stay usable with delayed real network responses", async ({ page }) => {
  const f = await seedStudent();
  await page.route("**/api/student/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.continue();
  });
  await enterStudent(page, f);
  await uploadReceipt(page, f);
  await page.reload();
  await expect(page.getByRole("region", { name: "Receipt history" }).getByText("Under review", { exact: true })).toBeVisible();
});
