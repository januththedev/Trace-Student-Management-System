"use client";
import { Alert, Button, PageBody } from "@/components/ui";
export default function ErrorPage({reset}:{reset:()=>void}){return <PageBody className="space-y-4"><Alert tone="bad">Unable to load these records. Your access may have changed, or the service may be unavailable.</Alert><Button onClick={reset}>Try again</Button></PageBody>;}
