import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { resetDb, closeDb, makeProgramme, makeIntake, makeStudent, makeEnrolment, makeStaff, principalOf } from "./helpers";
import { db } from "@/db/client";
import { students, enrolments, instalments, feePlanVersions, feePlanItems, staffScopes, staffAccounts, auditEvents, paymentEvents } from "@/db/schema";
import { searchStudents, studentDetail, editStudent, saveProgramme, saveIntake, programmeDetail, enrolmentHistory } from "@/server/services/directory";
import { createAdmission, decideAdmission } from "@/server/services/enrolments";
import { NextRequest } from "next/server";
import type { StaffPrincipal } from "@/server/auth/policy";
import { POST as financialAction } from "@/app/api/staff/enrolments/[id]/[action]/route";
import { POST as intakeAction } from "@/app/api/staff/programmes/[id]/intakes/route";
import { decryptNic, nicLookup } from "@/lib/crypto";

// Cookie/CSRF resolution is the sole mocked boundary. Routes still use real authorization
// principals, scoped queries, validation, transactions, and the real Postgres database.
const routeAuth=vi.hoisted(()=>({principal:null as StaffPrincipal|null}));
vi.mock("@/server/auth/staff",async importOriginal=>({...await importOriginal<typeof import("@/server/auth/staff")>(),requireStaff:async()=>{if(!routeAuth.principal)throw new Error("Missing test principal");return routeAuth.principal;}}));
beforeEach(resetDb); afterAll(closeDb);
async function fixture() {
 const a=await makeProgramme({name:"Visible programme"}), b=await makeProgramme({name:"Hidden programme"});
 const ia=await makeIntake(a.id), ib=await makeIntake(b.id);
 const shared=await makeStudent({fullName:"Shared Student"}), hidden=await makeStudent({fullName:"Hidden Student"}), unassigned=await makeStudent({fullName:"Unassigned Student"});
 await makeEnrolment(shared.id,ia.id,[{amountMinor:10000,dueDate:"2026-12-01"}]);
 await makeEnrolment(shared.id,ib.id,[{amountMinor:999999,dueDate:"2026-12-01"}]);
 await makeEnrolment(hidden.id,ib.id,[]);
 const staff=await makeStaff("ADMIN",{scopes:[{programmeId:a.id}]});
 const admin=principalOf(staff,[{programmeId:a.id}]), superAdmin=principalOf(await makeStaff("SUPER_ADMIN"));
 return {a,b,ia,ib,shared,hidden,unassigned,admin,superAdmin};
}
describe("scenario 10: student directory scope",()=>{
 it("search and count only visible people and visible enrolments, without encrypted identifiers",async()=>{
  const f=await fixture(); const r=await searchStudents(db(),f.admin,{});
  expect(r.count).toBe(1); expect(r.rows).toHaveLength(1); expect(r.rows[0].enrolments).toHaveLength(1);
  expect(r.rows[0].enrolments[0].programmeName).toBe("Visible programme");
  expect(JSON.stringify(r)).not.toContain(f.shared.nic); expect(r.rows[0]).not.toHaveProperty("nicEnc");
  expect((await searchStudents(db(),f.admin,{q:"Hidden"})).count).toBe(0);
  expect((await searchStudents(db(),f.admin,{nic:f.hidden.nic})).count).toBe(0);
  expect((await searchStudents(db(),f.admin,{nic:f.shared.nic})).count).toBe(1);
  expect((await searchStudents(db(),f.superAdmin,{})).count).toBe(3);
 });
 it("detail hides other programme balances and rejects guessed or malformed ids",async()=>{
  const f=await fixture(); const r=await studentDetail(db(),f.admin,f.shared.id);
  expect(r.enrolments).toHaveLength(1); expect(r.enrolments[0].summary.outstandingMinor).toBe(10000);
  await expect(studentDetail(db(),f.admin,f.hidden.id)).rejects.toMatchObject({code:"NOT_FOUND"});
  await expect(studentDetail(db(),f.admin,f.unassigned.id)).rejects.toMatchObject({code:"NOT_FOUND"});
  await expect(studentDetail(db(),f.admin,"invalid")).rejects.toMatchObject({code:"NOT_FOUND"});
 });
 it("paginates distinct people with a stable cursor and keeps total independent of cursor",async()=>{
  const f=await fixture(); const s=await makeStudent(); await makeEnrolment(s.id,f.ia.id,[]);
  const one=await searchStudents(db(),f.admin,{limit:1}); const two=await searchStudents(db(),f.admin,{limit:1,cursor:one.nextCursor!});
  expect(one.count).toBe(2); expect(two.count).toBe(2); expect(two.rows[0].id).not.toBe(one.rows[0].id); expect(two.nextCursor).toBeNull();
  await expect(searchStudents(db(),f.admin,{nic:"199"})).rejects.toMatchObject({code:"VALIDATION"});
 });
 it("NIC correction is Super Admin only, encrypted, unique, versioned, audited, and replay-safe",async()=>{
  const f=await fixture(); const v={studentId:f.shared.id,expectedVersion:1,fullName:"Corrected Student",phone:null,email:null,doNotCall:false,wrongNumber:false,nic:"200012345678",reason:"Correct recorded identifier"};
  await expect(editStudent(f.admin,v,"restricted-key")).rejects.toMatchObject({code:"FORBIDDEN"});
  const result=await editStudent(f.superAdmin,v,"correction-key"); expect(result.version).toBe(2);
  expect(await editStudent(f.superAdmin,v,"correction-key")).toEqual(result);
  const [stored]=await db().select().from(students).where(eq(students.id,f.shared.id));
  expect(stored.nicEnc).not.toBe(v.nic); expect(decryptNic(stored.nicEnc!)).toBe(v.nic); expect(stored.nicLookup).toBe(nicLookup(v.nic));
  await expect(editStudent(f.superAdmin,{...v,expectedVersion:2,nic:f.hidden.nic},"duplicate-key")).rejects.toMatchObject({code:"CONFLICT"});
  await expect(editStudent(f.superAdmin,{...v,nic:undefined},"stale-key")).rejects.toMatchObject({code:"STALE"});
  const logs=await db().select().from(auditEvents); expect(logs).toHaveLength(1); expect(JSON.stringify(logs)).not.toContain(v.nic);
 });
 it("rechecks authoritative grants and disabled accounts inside contact mutations",async()=>{
  const f=await fixture(); await db().delete(staffScopes).where(eq(staffScopes.staffId,f.admin.id));
  const v={studentId:f.shared.id,expectedVersion:1,fullName:"Updated Student",phone:null,email:null,doNotCall:true,wrongNumber:false,reason:"Contact changed"};
  await expect(editStudent(f.admin,v,"removed-scope")).rejects.toMatchObject({code:"NOT_FOUND"});
  await db().update(staffAccounts).set({status:"DEACTIVATED"}).where(eq(staffAccounts.id,f.superAdmin.id));
  await expect(editStudent(f.superAdmin,v,"inactive-staff")).rejects.toMatchObject({code:"UNAUTHENTICATED"});
 });
 it("requires separate creation capability and atomically grants creator scope",async()=>{
  const f=await fixture(); const v={code:"NEW",name:"New programme",status:"ACTIVE" as const,isPublic:true};
  await expect(saveProgramme(f.admin,v,"create-denied")).rejects.toMatchObject({code:"FORBIDDEN"});
  await db().update(staffAccounts).set({capabilities:["programme.create"]}).where(eq(staffAccounts.id,f.admin.id));
  const created=await saveProgramme(f.admin,v,"create-allowed");
  expect(await saveProgramme(f.admin,v,"create-allowed")).toEqual(JSON.parse(JSON.stringify(created)));
  const scopes=await db().select().from(staffScopes).where(eq(staffScopes.programmeId,created.id));expect(scopes[0].staffId).toBe(f.admin.id);
  await expect(saveIntake(f.superAdmin,{programmeId:f.a.id,code:"BAD",label:"Bad dates",startDate:"2026-12-02",endDate:"2026-12-01",status:"ACTIVE",isPublic:true},"invalid-dates")).rejects.toThrow();
  await expect(saveProgramme(f.superAdmin,{...v,code:"BANNER",bannerPath:"/banners/../../.env"},"unsafe-banner")).rejects.toMatchObject({code:"VALIDATION"});
 });
});
describe("admission acceptance idempotency",()=>{
 it("repeated and concurrent acceptance creates exactly one enrolment and schedule",async()=>{
  const f=await fixture(); const [plan]=await db().insert(feePlanVersions).values({intakeId:f.ia.id,versionNo:1}).returning();
  await db().insert(feePlanItems).values([{versionId:plan.id,sequence:1,periodLabel:"January",amountMinor:10000,dueDate:"2027-01-01"},{versionId:plan.id,sequence:2,periodLabel:"February",amountMinor:20000,dueDate:"2027-02-01"}]);
  const a=await createAdmission(f.superAdmin,{intakeId:f.ia.id,applicantName:"New Applicant",nic:"200112345678"});
  const input={admissionId:a.id,decision:"ACCEPTED" as const,expectedVersion:1,confirmExistingStudent:false};
  const [r1,r2]=await Promise.all([decideAdmission(f.superAdmin,input),decideAdmission(f.superAdmin,input)]);
  expect(r1.enrolmentId).toBe(r2.enrolmentId); expect([r1.replayed,r2.replayed].sort()).toEqual([false,true]);
  expect((await decideAdmission(f.superAdmin,input)).enrolmentId).toBe(r1.enrolmentId);
  const schedules=await db().select().from(instalments).where(eq(instalments.enrolmentId,r1.enrolmentId!));expect(schedules).toHaveLength(2);
  const [{n}]=await db().select({n:sql<number>`count(*)::int`}).from(enrolments).where(eq(enrolments.id,r1.enrolmentId!));expect(n).toBe(1);
 });
 it("requires explicit confirmation before adding an enrolment to an existing person",async()=>{
  const f=await fixture(); const a=await createAdmission(f.superAdmin,{intakeId:f.ib.id,applicantName:"Existing person",nic:f.unassigned.nic});
  const input={admissionId:a.id,decision:"ACCEPTED" as const,expectedVersion:1,confirmExistingStudent:false};
  await expect(decideAdmission(f.superAdmin,input)).rejects.toMatchObject({code:"CONFLICT",details:{needsConfirmation:true}});
  const r=await decideAdmission(f.superAdmin,{...input,confirmExistingStudent:true});
  const [e]=await db().select().from(enrolments).where(eq(enrolments.id,r.enrolmentId!));expect(e.studentId).toBe(f.unassigned.id);
 });
});


describe("directory concurrency and intake boundaries",()=>{
 it("rejects changed payload replay and permits only one of two concurrent profile edits",async()=>{
  const f=await fixture();const v={studentId:f.shared.id,expectedVersion:1,fullName:"Updated shared student",phone:null,email:null,doNotCall:false,wrongNumber:false,reason:"Correct phone record"};
  const writes=await Promise.allSettled([editStudent(f.admin,v,"first-contact-edit"),editStudent(f.admin,{...v,fullName:"Another name"},"second-contact-edit")]);
  expect(writes.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  const failed=writes.find(r=>r.status==="rejected") as PromiseRejectedResult;expect(failed.reason).toMatchObject({code:"STALE"});
  const winningKey=writes[0].status==="fulfilled"?"first-contact-edit":"second-contact-edit";
  await expect(editStudent(f.admin,{...v,fullName:"Different replay payload"},winningKey)).rejects.toMatchObject({code:"IDEMPOTENCY_MISMATCH"});
 });
 it("limits intake and fee-version details to grants and assigns a newly created intake to its creator",async()=>{
  const f=await fixture(); const sibling=await makeIntake(f.a.id);
  const account=await makeStaff("ADMIN",{capabilities:["programme.manage","programme.create"],scopes:[{programmeId:f.a.id,intakeId:f.ia.id}]});
  const p=principalOf(account,[{programmeId:f.a.id,intakeId:f.ia.id}]);
  const detail=await programmeDetail(db(),p,f.a.id); expect(detail.intakes.map(i=>i.id)).toEqual([f.ia.id]);
  await expect(saveIntake(p,{id:sibling.id,expectedVersion:1,programmeId:f.a.id,code:"OUTSIDE",label:"Outside",startDate:"2026-01-01",endDate:null,status:"ACTIVE",isPublic:true},"outside-intake")).rejects.toMatchObject({code:"NOT_FOUND"});
  const created=await saveIntake(p,{programmeId:f.a.id,code:"CREATOR",label:"Creator intake",startDate:"2027-01-01",endDate:null,status:"DRAFT",isPublic:false},"new-scoped-intake");
  const grants=await db().select().from(staffScopes).where(eq(staffScopes.intakeId,created.id));expect(grants[0].staffId).toBe(account.id);
  await expect(saveIntake(f.superAdmin,{programmeId:f.a.id,code:"creator",label:"Other label",startDate:"2027-01-01",endDate:null,status:"ACTIVE",isPublic:false},"duplicate-intake-code")).rejects.toMatchObject({code:"CONFLICT"});
 });
 it("returns all payment events beyond the service's summary window, scoped to one enrolment",async()=>{
  const f=await fixture();const detail=await studentDetail(db(),f.admin,f.shared.id);const id=detail.enrolments[0].id;
  await db().insert(paymentEvents).values(Array.from({length:101},(_,i)=>({enrolmentId:id,kind:"HISTORICAL_IMPORT" as const,amountMinor:100,effectiveDate:"2026-01-01",sourceReference:`history-${i}`})));
  const history=await enrolmentHistory(db(),f.admin,id);expect(history.events).toHaveLength(101);
  const hidden=await studentDetail(db(),f.superAdmin,f.hidden.id);
  await expect(enrolmentHistory(db(),f.admin,hidden.enrolments[0].id)).rejects.toMatchObject({code:"NOT_FOUND"});
 });
});

describe("real database route payload integration",()=>{
 function request(path:string,body:unknown,key:string){return new NextRequest(`http://localhost${path}`,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":key},body:JSON.stringify(body)});}
 it("previews and grants a validated award using the route enrolment id, with replay protection",async()=>{
  const f=await fixture();routeAuth.principal=f.superAdmin;const detail=await studentDetail(db(),f.admin,f.shared.id);const id=detail.enrolments[0].id;
  const [inst]=await db().select().from(instalments).where(eq(instalments.enrolmentId,id));
  const body={type:"DISCOUNT",basis:"PERCENT",value:2500,reason:"Approved scholarship",effectiveFrom:"2026-01-01",instalmentIds:[inst.id],expectedEnrolmentVersion:1};
  const preview=await financialAction(request(`/api/staff/enrolments/${id}/exemption-preview`,body,"route-preview"),{params:Promise.resolve({id,action:"exemption-preview"})});
  expect(preview.status).toBe(200);expect((await preview.json()).totalExemption).toBe(2500);
  const invoke=()=>financialAction(request(`/api/staff/enrolments/${id}/exemptions`,body,"route-award-grant"),{params:Promise.resolve({id,action:"exemptions"})});
  const first=await invoke();expect(first.status).toBe(200);const saved=await first.json();const replay=await invoke();expect(replay.status).toBe(200);expect((await replay.json()).awardId).toBe(saved.awardId);
  expect((await studentDetail(db(),f.admin,f.shared.id)).enrolments[0].summary.outstandingMinor).toBe(7500);
 });
 it("creates an intake with date refinements while deriving programme id from the route",async()=>{
  const f=await fixture();routeAuth.principal=f.superAdmin;const id=f.a.id;
  const body={code:"ROUTE-INTAKE",label:"Route intake",startDate:"2027-01-01",endDate:"2027-06-01",status:"ACTIVE",isPublic:true};
  const response=await intakeAction(request(`/api/staff/programmes/${id}/intakes`,body,"route-intake-create"),{params:Promise.resolve({id})});expect(response.status).toBe(200);expect((await response.json()).programmeId).toBe(id);
  const invalid=await intakeAction(request(`/api/staff/programmes/${id}/intakes`,{...body,endDate:"2026-01-01"},"route-bad-dates"),{params:Promise.resolve({id})});expect(invalid.status).toBe(400);
 });
});
