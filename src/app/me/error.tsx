"use client";
import { Button, ButtonLink, Card } from "@/components/ui";

export default function PaymentError({ retry }: { retry: () => void }) {
  return <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6"><Card className="space-y-4 p-6"><h1 className="text-xl">Your payments could not be loaded</h1><p role="alert" className="text-sm text-muted">Check your connection and try again. If your session has ended, return to student entry.</p><div className="flex flex-wrap gap-3"><Button onClick={retry}>Try again</Button><ButtonLink href="/" variant="secondary">Student entry</ButtonLink></div></Card></main>;
}
