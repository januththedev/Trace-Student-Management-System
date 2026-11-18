function task(id: string, title: string, group: string, area: string, href: string, summary: string, steps: string[], superOnly = false) {
  return { id, title, group, area, href, summary, steps, superOnly };
}

export const TUTORIALS = [
  task("daily-overview", "Start your day", "Getting started", "GENERAL", "/staff", "Know what needs attention first.", [
    "Open Command centre. Start with receipts waiting for review, then calls and promises due.",
    "Use the priority links to open the relevant queue. Check the date and the amount before taking action.",
    "Use Students to find a specific account. The question-mark button opens Help & support from every staff page."]),
  task("find-student", "Find a student", "Students", "STUDENTS", "/staff/students", "Find the right account and understand its balance.", [
    "Open Students and search using the student's name or reference. Check the programme and intake.",
    "Open the student's account and choose the correct enrolment. One student can have more than one enrolment.",
    "Read outstanding, overdue, approved payments and pending claims separately. A pending receipt has not yet reduced the approved balance."]),
  task("add-student", "Add a student and enrolment", "Students", "STUDENTS", "/staff/admissions", "Create a student through an accepted application.", [
    "From Students, choose New application. Select the intake and enter the applicant's name, NIC and contact details.",
    "Create the application, then choose Decide application. Select Accepted after checking that the intake fee plan is correct.",
    "Confirm the decision and open the new enrolment. Acceptance creates the student and enrolment; an existing NIC needs explicit confirmation to reuse that person."]),
  task("student-contact", "Update contact details", "Students", "STUDENTS", "/staff/students", "Correct contact information and calling preferences.", [
    "Find and open the student. Confirm the name and reference before editing.",
    "Edit contact details or calling preferences. Wrong-number and do-not-call flags affect follow-up calls.",
    "Save and check the updated values. If someone else changed the account, refresh before trying again."]),
  task("admissions", "Review an admission", "Students", "ADMISSIONS", "/staff/admissions", "Record an admission decision with a clear reason.", [
    "Open Admissions and select the application you need to review.",
    "Check the applicant and intake, then choose the appropriate decision and enter the requested reason.",
    "Confirm and check the resulting status. Acceptance creates the student and enrolment using the intake's current fee plan; other decisions do not record a payment."]),
  task("programme-intake", "Set up a programme and intake", "Course setup", "PROGRAMMES", "/staff/programmes", "Organise courses and student batches.", [
    "Open Programmes and create a programme with its code and name.",
    "Open that programme and add an intake. Check its code, label and start date.",
    "Review the intake and fee plan before enrolling students or sharing entry access."]),
  task("share-entry", "Share a student entry link", "Course setup", "PROGRAMMES", "/staff/programmes", "Help students open the correct intake.", [
    "Open the relevant programme and find the intake you want to share.",
    "Use the entry-link controls to copy or open that intake's link.",
    "Check the link shows the correct course. The student enters their NIC; the link does not create an enrolment or grant access to another intake."]),
  task("fee-plan", "Create and change a fee plan", "Course setup", "PROGRAMMES", "/staff/programmes", "Preview the impact before applying changes.", [
    "Open the programme and intake, then review the current fee-plan version.",
    "Create the revised schedule. Check every instalment, due date and amount, then preview its impact.",
    "Review the selected enrolments before applying the change. Existing payments and history remain on the account."]),
  task("approve-receipt", "Approve a receipt", "Payments", "RECEIPTS", "/staff/review", "Check the evidence before recording a payment.", [
    "Open Receipt review, select the correct intake and choose a pending receipt.",
    "Compare the bank evidence with the student, claimed amount and transfer date. Zoom or open the evidence when needed.",
    "Choose Approve, review the confirmation and save. Check the updated status and balance; money changes only after approval succeeds."]),
  task("reject-receipt", "Reject or skip a receipt", "Payments", "RECEIPTS", "/staff/review", "Explain the issue without losing the evidence.", [
    "Open the pending receipt and check its evidence and student details.",
    "Choose Reject only when it cannot be accepted, and give a clear reason. Use Skip instead if you need to decide later.",
    "Confirm and check the status. Skipping keeps the receipt pending; Show skipped again brings those cards back."]),
  task("correct-receipt", "Undo or correct an approval", "Payments", "RECEIPTS", "/staff/review", "Fix a mistake while keeping payment history.", [
    "After approval, use quick Undo if it is still available and the decision was incorrect.",
    "For an older decision, open receipt history and use the permitted correction action. Check the previous amount and allocation.",
    "Enter the required reason and confirm. Recheck the balance and history; corrections preserve the original event."]),
  task("record-call", "Record a follow-up call", "Follow-ups", "CALLS", "/staff/calls", "Save the outcome and next action.", [
    "Open Calls & follow-ups and select the student. Check their balance, pending evidence and contact flags.",
    "Make the call when appropriate, then choose the actual outcome. Opening the dialler does not record a completed call.",
    "Add useful notes and any required next action, then save. Check contact history and open tasks before moving on."]),
  task("payment-promise", "Record a promise to pay", "Follow-ups", "CALLS", "/staff/calls", "Capture an agreed amount and date.", [
    "Select the student in Calls & follow-ups and choose Promised to pay.",
    "Enter the agreed amount and promised date. Select the relevant instalments and add useful notes.",
    "Save and check the promise and follow-up task. A promise is not collected money; actual payment evidence still needs review."]),
  task("tasks-calendar", "Manage tasks and holidays", "Follow-ups", "CALLS", "/staff/calls", "Keep the next contact date accurate.", [
    "Open a call card and review its open tasks and contact history.",
    "Use the available task actions to complete or update the next step. Give the required reason.",
    "Open Business holidays to manage the calling calendar. Check business days and contact-hour rules before scheduling another call."]),
  task("exemptions", "Record an exemption or sponsorship", "Payments", "STUDENTS", "/staff/students", "Reduce obligations without recording fake cash.", [
    "Open the student's correct enrolment and find the exemption controls.",
    "Choose the type and basis. Enter the value, effective date and reason, plus sponsor details when required.",
    "Save and check the adjusted obligations. Exemptions are not cash receipts. Revoke an incorrect award through its recorded action."]),
  task("withdraw-enrolment", "Withdraw an enrolment", "Students", "STUDENTS", "/staff/students", "Check future charges and preserve past payments.", [
    "Open the correct enrolment and review unpaid instalments, payments and credits.",
    "Choose Withdraw and enter the effective date and reason. Review the charges that will be cancelled.",
    "Confirm and check the status and remaining balance. Withdrawal preserves earlier payments and financial history."]),
  task("reports", "Download a PDF or CSV report", "Reports & imports", "REPORTS", "/staff/reports", "Choose dates and export the report you need.", [
    "Open Reports, choose the date range and apply it. Select the report to export.",
    "Keep identifiers masked unless an authorised full-identifier export is specifically required.",
    "Choose Download PDF for reading or printing, or Download CSV for a spreadsheet. Prepare large CSV handles longer exports with progress checking."]),
  task("import-students", "Import students from CSV", "Reports & imports", "IMPORTS", "/staff/imports", "Run a dry-run before committing.", [
    "Open Imports and download the template. Use one row per instalment and the same reference to group a student's schedule.",
    "Upload the file and run a dry-run. Read and correct the reported issues before continuing.",
    "Commit only after reviewing the results. Identity issues go to the resolution queue rather than silently creating guessed identities."]),
  task("identity-resolution", "Resolve an import identity issue", "Reports & imports", "IMPORTS", "/staff/imports/identity", "Review staged details before creating records.", [
    "Open Identity resolution from Imports and select an unresolved record.",
    "Check the staged details, correct the identity and schedule, and preview the resolution. Investigate any conflict.",
    "Confirm the reviewed resolution and check the created enrolment. Never guess a NIC or merge two people to clear a conflict."], true),
  task("manage-staff", "Invite staff and manage access", "Administration", "TEAM", "/staff/team", "Give each admin only the access they need.", [
    "Open Staff and choose Invite a team member. Enter their details and the appropriate role.",
    "Choose their programmes or intakes and delegated capabilities. Review the invitation before saving.",
    "Use Edit access for changes and Deactivate when access must end. Keep at least one active Super Admin."], true),
  task("trash-restore", "Restore an item from Trash", "Administration", "TRASH", "/staff/trash", "Recover an eligible record during retention.", [
    "Open Trash and select the correct record type.",
    "Check the item and deletion date, then use Restore if it is still eligible.",
    "Review the restored record in its original area. Retention and dependency rules still apply; financial history is preserved."], true),
  task("storage", "Check receipt storage", "Administration", "STORAGE", "/staff", "Understand capacity and archived evidence.", [
    "Open Command centre and find the receipt-storage section.",
    "Read measured usage, remaining capacity and the measurement time. An old measurement is not a new scan.",
    "Open archived evidence through the normal receipt viewer when needed. Archival preserves the original evidence; pending receipts are not discarded."], true),
  task("send-feedback", "Send feedback or ask for help", "Getting started", "SUPPORT", "/staff/support", "Tell us what is confusing or needs improving.", [
    "Open Help & support and choose Send feedback. Select a problem, improvement or question, and the relevant area.",
    "Write a short title and describe the steps, what happened and what you expected. Leave out student personal information.",
    "Send and keep the reference. Open My feedback to see its status and any response from a Super Admin."]),
  task("charge-adjustment", "Understand charge adjustments", "Payments", "STUDENTS", "/staff/students", "Read changes to the original instalment charges.", [
    "Open the student's correct enrolment. The instalment timeline separates original charges, adjustments, exemptions and payments.",
    "Find Charge adjustments to read the amount, effective date and reason for each recorded change. A negative adjustment reduces the charge.",
    "Compare the net obligation and remaining balance. Use the programme's fee-plan workflow for permitted fee changes; an adjustment is not a bank receipt."]),
  task("apply-credit", "Apply unapplied credit", "Payments", "STUDENTS", "/staff/students", "Use an existing credit against an unpaid instalment.", [
    "Open the student's enrolment and compare unapplied credit with remaining instalments.",
    "Choose Apply credit and check the target instalment and amount before saving.",
    "Check the resulting allocation and remaining credit. Applying credit uses money already recorded; it is not a new collection."]),
  task("correct-identity", "Correct a student's NIC", "Administration", "STUDENTS", "/staff/students", "Correct an identifier only after checking the person.", [
    "Open the student's profile and confirm their reference and identity before making a correction.",
    "Enter the verified identifier in Correct NIC and give a clear reason. A conflicting NIC must be investigated rather than merged automatically.",
    "Save and check the masked identifier. Leave Correct NIC blank when changing only contact information."], true),
  task("manage-feedback", "Review and respond to feedback", "Administration", "SUPPORT", "/staff/support", "Keep the team informed about their requests.", [
    "Open Help & support and choose Feedback inbox. Filter by status and open the request.",
    "Read the steps and expected result. Choose a clear status and write a helpful response with the next action.",
    "Save the response. The author can see the status and reply in My feedback; earlier replies remain in the conversation."], true),
];
