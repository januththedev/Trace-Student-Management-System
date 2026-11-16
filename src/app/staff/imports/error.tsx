"use client";
import { Alert, Button } from "@/components/ui";
export default function ErrorPage({reset}:{reset:()=>void}){return <div className="space-y-4 p-4 sm:p-6"><Alert tone="bad">Unable to load these records. Your access may have changed, or the service may be unavailable.</Alert><Button onClick={reset}>Try again</Button></div>;}
