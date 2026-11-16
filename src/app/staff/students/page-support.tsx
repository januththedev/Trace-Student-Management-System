import { z } from "zod";
import { notFound, redirect } from "next/navigation";
import { currentStaff } from "@/server/auth/staff";
import { AppError } from "@/server/http";
export async function staffPage() { const p=await currentStaff(); if(!p) redirect("/staff/login"); return p; }
export async function scoped<T>(read:()=>Promise<T>,id?:string):Promise<T> { if(id&&!z.string().uuid().safeParse(id).success)notFound();try{return await read();}catch(e){if(e instanceof AppError && e.code==="NOT_FOUND") notFound();throw e;} }
