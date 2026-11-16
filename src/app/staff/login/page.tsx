import { redirect } from "next/navigation";
import { currentStaff } from "@/server/auth/staff";
import SignIn from "./sign-in";
import { AuthFrame } from "../_shell/auth-frame";

export const dynamic = "force-dynamic";
export const metadata = { title: "Staff sign in" };
export default async function LoginPage() {
  if (await currentStaff()) redirect("/staff");
  return <AuthFrame><p className="text-sm font-medium text-[#8fe3e9]">Welcome back</p><h2 className="mt-2 text-2xl font-semibold text-white">Sign in</h2><p className="mb-6 mt-2 text-sm text-white/65">Use your staff email and password to continue.</p><SignIn /></AuthFrame>;
}
