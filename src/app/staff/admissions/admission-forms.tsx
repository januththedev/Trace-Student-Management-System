"use client";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { Alert, Button } from "@/components/ui";
import { Dialog, toast } from "@/components/ui/kit";
import { api, ApiError, newIdemKey } from "@/lib/client-api";
import { Check, Input, MutationForm, Select, value } from "../students/form-parts";
export function NewAdmission({choices}:{choices:{id:string;label:string;programmeName:string}[]}){return <MutationForm url="/api/staff/admissions" label="Create application" build={f=>({intakeId:value(f,"intakeId"),applicantName:value(f,"applicantName"),nic:value(f,"nic")||undefined,phone:value(f,"phone")||undefined,email:value(f,"email")||undefined,sponsorshipRequested:value(f,"sponsorshipRequested")||undefined,notes:value(f,"notes")})}>
 <Select name="intakeId" label="Programme / intake" options={choices.map(i=>({value:i.id,label:`${i.programmeName} | ${i.label}`}))}/><div className="grid gap-4 sm:grid-cols-2"><Input name="applicantName" label="Applicant name" required/><Input name="nic" label="NIC" hint="A valid identifier is required before acceptance."/><Input name="phone" label="Phone" type="tel"/><Input name="email" label="Email" type="email"/><Input name="sponsorshipRequested" label="Sponsorship request (optional)"/><Input name="notes" label="Application notes"/></div></MutationForm>;}
export function DecisionDialog({id,version,name}:{id:string;version:number;name:string}){
  const router=useRouter();const [open,setOpen]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [confirm,setConfirm]=useState(false);const key=useRef<string|undefined>(undefined);
  async function decide(e:FormEvent<HTMLFormElement>){e.preventDefault();if(busy)return;const f=new FormData(e.currentTarget);if(confirm&&!f.has("confirmExistingStudent")){setError("Confirm adding the enrolment to the existing person.");return;}setBusy(true);setError("");key.current??=newIdemKey();
  try{await api(`/api/staff/admissions/${id}`,{method:"POST",idempotencyKey:key.current,body:{decision:value(f,"decision"),reason:value(f,"reason")||undefined,expectedVersion:version,confirmExistingStudent:f.has("confirmExistingStudent")}});setOpen(false);key.current=undefined;toast.success("Decision saved.");router.refresh();}catch(e){if(e instanceof ApiError&&e.details?.needsConfirmation){setConfirm(true);key.current=undefined;}const m=e instanceof Error?e.message:"Decision failed.";setError(m);toast.error(m);}finally{setBusy(false);}}
  return <><Button variant="secondary" onClick={()=>setOpen(true)}><ClipboardCheck/>Decide application</Button>
  <Dialog open={open} onOpenChange={setOpen} title="Application decision" description={name}>
   <form method="post" autoComplete="off" onSubmit={decide} onChange={e=>{key.current=undefined;if((e.target as Element).getAttribute("name")==="decision"){setConfirm(false);setError("");}}} className="space-y-4">
    <Select name="decision" label="Decision" options={["ACCEPTED","WAITLISTED","REJECTED","WITHDRAWN","UNDER_REVIEW"].map(value=>({value,label:value.replaceAll("_"," ")}))}/>
    <Input name="reason" label="Decision reason" hint="Required for rejection or withdrawal."/>
    {confirm&&<Check name="confirmExistingStudent" label="Same NIC exists - add this enrolment to the same person"/>}
    {error&&<Alert tone="bad">{error}</Alert>}
    <div className="flex flex-wrap gap-2"><Button disabled={busy}>{busy?"Saving...":"Confirm decision"}</Button><Button type="button" variant="ghost" onClick={()=>setOpen(false)}>Close</Button></div>
   </form>
  </Dialog></>;
 }
