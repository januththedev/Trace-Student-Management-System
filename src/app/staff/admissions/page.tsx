import { UserPlus } from "lucide-react";
import { Disclosure } from "@/components/ui/kit";
import { db } from "@/db/client";
import { can } from "@/server/auth/policy";
import { admissionDirectory } from "@/server/services/directory";
import { Badge, ButtonLink, Card, EmptyState, PageBody } from "@/components/ui";
import { Inbox } from "lucide-react";
import { PageHeader } from "@/app/staff/_shell/page-header";
import { staffPage } from "../students/page-support";
import { DecisionDialog, NewAdmission } from "./admission-forms";
import { StateFilter } from "./state-filter";
export const dynamic="force-dynamic";
export default async function AdmissionsPage({searchParams}:{searchParams:Promise<{state?:string}>}){const p=await staffPage();const {state}=await searchParams;const d=await admissionDirectory(db(),p,state);
 return <><PageHeader title="Admissions" sub="Applications and enrolment decisions"/><PageBody className="space-y-5"><Card className="p-4"><Disclosure title={<><UserPlus aria-hidden className="size-4 text-accent" />New application</>} triggerClassName="min-h-11 cursor-pointer text-lg"><div className="pt-3">{d.choices.length?<NewAdmission choices={d.choices}/>:<EmptyState icon={<Inbox/>} title="No available intake in your scope"/>}</div></Disclosure></Card><StateFilter initial={state}/>
 <p className="text-sm text-muted">Latest {d.rows.length} applications in your scope (up to 200).</p>{d.rows.length?<div className="grid gap-3 lg:grid-cols-2">{d.rows.map(a=><Card key={a.id} className="space-y-3 p-4"><div className="flex flex-wrap justify-between gap-3"><h2 className="font-medium">{a.applicantName}</h2><Badge tone={a.state==="ACCEPTED"?"ok":a.state==="UNDER_REVIEW"?"warn":"neutral"}>{a.state.replaceAll("_"," ")}</Badge></div><p className="text-sm">{a.programmeName} | {a.intakeLabel}</p><p className="text-sm text-muted">{a.nicMasked??"Identifier unresolved"} | {a.phone??"No phone"}</p>{a.sponsorshipRequested&&<p className="text-sm">Sponsorship requested: {a.sponsorshipRequested}</p>}{a.notes&&<p className="text-sm">{a.notes}</p>}{a.decisionReason&&<p className="text-sm">Decision reason: {a.decisionReason}</p>}{a.enrolmentId?<ButtonLink variant="secondary" href={`/staff/enrolments/${a.enrolmentId}`}>View enrolment</ButtonLink>:can(p,"admissions.decide")&&<DecisionDialog key={a.version} id={a.id} version={a.version} name={a.applicantName}/>}</Card>)}</div>:<EmptyState icon={<Inbox/>} title="No applications match this state"/>}</PageBody></>;
}
