"use client";
import { Check, Input, MutationForm, value } from "./form-parts";
export function ContactForm({student,canCorrectNic}:{student:{id:string;fullName:string;phone:string|null;email:string|null;version:number;doNotCall:boolean;wrongNumber:boolean};canCorrectNic:boolean}) {
 return <MutationForm url={`/api/staff/students/${student.id}`} method="PATCH" label="Save profile" build={f=>({fullName:value(f,"fullName"),phone:value(f,"phone")||null,email:value(f,"email")||null,doNotCall:f.has("doNotCall"),wrongNumber:f.has("wrongNumber"),reason:value(f,"reason"),expectedVersion:student.version,...(canCorrectNic&&value(f,"nic")?{nic:value(f,"nic")}: {})})}>
 <div className="grid gap-4 sm:grid-cols-2"><Input name="fullName" label="Full name" initial={student.fullName} required/><Input name="phone" label="Phone" type="tel" initial={student.phone??""}/><Input name="email" label="Email" type="email" initial={student.email??""}/>{canCorrectNic&&<Input name="nic" label="Correct NIC" hint="Leave blank to keep the current identifier. Super Admin only."/>}</div>
 <Check name="doNotCall" label="Do not call" checked={student.doNotCall}/><Check name="wrongNumber" label="Number is incorrect" checked={student.wrongNumber}/><Input name="reason" label="Reason for change" required/>
 </MutationForm>;
}
