"use client";
export default function ErrorPage({ reset }: { reset: () => void }) { return <div className="m-6 rounded-lg bg-card p-8 text-ink"><h2 className="text-xl font-bold">Invitation could not load</h2><button onClick={reset} className="btn mt-4 min-h-11 rounded-lg bg-accent px-5 text-inv-ink focus-visible:ring-4 focus-visible:ring-accent/30">Try again</button></div>; }
