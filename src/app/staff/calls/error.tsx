"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="p-8"><h1 className="text-2xl font-bold">Calls could not be loaded</h1><p className="my-4">Check your connection and try again.</p><button className="min-h-11 rounded bg-slate-950 px-5 text-white" onClick={reset}>Try again</button></main>;
}
