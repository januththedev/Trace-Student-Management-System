"use client";
import { Button, ButtonLink, Card } from "@/components/ui";

export default function MetricError({ retry }: { retry: () => void }) {
  return <main className="px-4 py-6 sm:px-6"><Card className="space-y-4 p-6"><h1 className="text-xl">These records could not be loaded</h1><p role="alert" className="text-sm text-muted">Check your connection and try again to see the current figures.</p><div className="flex flex-wrap gap-3"><Button onClick={retry}>Try again</Button><ButtonLink href="/staff" variant="secondary">Command centre</ButtonLink></div></Card></main>;
}
