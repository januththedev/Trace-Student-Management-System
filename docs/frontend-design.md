# Frontend design

Implemented 2026-11-17. The direction is bold branding for students and a predominantly clean,
professional staff workspace, using the existing T2T identity and course banners.

The shared system uses Host Grotesk, JetBrains Mono for identifiers, teal #0d7480, deep teal
#102e32 and mint inverse actions. Financial surfaces remain white and high contrast, with
separate pending, approved, overdue, credit and net-obligation values. The 2/4/6px radius scale
applies to controls/panels, with 8/12px for larger frames. Hover/press feedback, 44px primary
controls, reduced motion and visible keyboard focus remain shared behaviors.

Student entry has clearer course branding and an accessible NIC/intake form. The payment
overview leads with the next collectible instalment, exact remaining balance, pending evidence,
credit guidance and a working upload/history anchor before its full summary. Fixed intake links
retain NIC-only entry. Existing receipts, history, upload limits and authorization are unchanged.

Staff navigation has a persistent desktop context bar, grouped sidebar and mint selected state.
The mobile menu uses Radix focus containment and restores the opener on Escape; desktop resize
closes the modal. Its real sign-out action sends the required idempotency key and surfaces
network errors. Staff overview leads with scoped review priorities and directs each pending row
to that actual receipt. Shared headers/cards/stats carry the system through the remaining pages.

The receipt viewer and call queue account for the new top bar when sticky. Explicit mobile grid
tracks and shrinkable fields prevent long instalment/course labels widening the page.

Verification and preview

- Build, TypeScript and lint passed. 78 deployment traces exclude all private/test/QA artifacts.
- 35 populated route/width combinations passed at 320, 390, 768, 1024 and 1440px: no document
  overflow or clipped form controls. Mobile menu focus, Escape, resize and real logout passed.
- The full Playwright run passed 37 existing cases. One mobile call journey assumed its random
  enrolment appeared in the first keyset batch. The test now uses the real Load more enrolments
  control; its desktop/mobile focused rerun passed 2/2, preserving all financial assertions.
  All 38 scenarios are covered across these runs; this is not one green 38-case run.
- Screenshot review uses synthetic students and sample evidence in an isolated local PostgreSQL
  database. No production data was seeded or changed. Physical phone testing, a formal WCAG
  audit and production field performance were not performed.

Local populated preview: http://localhost:3100 (isolated synthetic database). Core screenshots:
`output/playwright/final-{entry,student,staff,staff-review}-{390,1440}.png`. The ignored
`.agents-logs/ui-preview-server.cjs` launches it using synthetic preview configuration.

The design-taste skill's shared-system and interaction guidance was applied to an operational
app. Its static marketing layout checker reports missing .wrap because this Next/Tailwind app
uses existing shared max-width containers; marketing section-height recipes are not an app
acceptance gate. Actual DOM bounds and workflow tests are recorded above. The checker's own
browser profile was moved to system Temp after stopping only its task-owned PIDs. Browser
profiles must stay outside the repository: Turbopack can read them during dynamic filesystem
tracing even when final deployment-trace exclusions omit them.

PDF reports and compact pages (2026-11-17)

Reports offer Download PDF alongside CSV for every report selection. Both formats use
the same scoped snapshot, fresh capabilities, default NIC masking and explicit audited
Super Admin full-NIC option. PDFs show filters, Colombo timestamps, decimal LKR,
repeating headers and page numbers; wide tables continue in column groups with repeated
identity columns. Local licensed static Noto fonts support Sinhala/Tamil shaping.

Simple pages should fit the viewport whenever the content allows. The sidebar adapts
spacing to screen height, preserves 44px links and keeps the account menu visible. Entry
and sign-in reduce supporting copy and spacing on short screens; long forms, records,
validation results and zoomed views retain scrolling. Import inputs sit side by side on
desktop to avoid a tall empty form. Do not hide overflowing content to remove a scrollbar.
