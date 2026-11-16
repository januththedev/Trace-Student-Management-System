"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarRange } from "lucide-react";
import { Button } from "@/components/ui";
import { DatePicker } from "@/components/ui/kit";

export function DateRange({ from, to }: { from: string; to: string }) {
  const router = useRouter();
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  return (
    <form className="grid w-full grid-cols-2 items-end gap-3 sm:flex sm:w-auto" onSubmit={(e) => { e.preventDefault(); router.push(`/staff/reports?from=${f}&to=${t}`); }}>
      <div className="min-w-0 text-sm sm:w-44"><label htmlFor="r-from" className="mb-1.5 block font-medium text-ink-2">From</label><DatePicker id="r-from" value={f} onChange={setF} max={t} /></div>
      <div className="min-w-0 text-sm sm:w-44"><label htmlFor="r-to" className="mb-1.5 block font-medium text-ink-2">To / as of</label><DatePicker id="r-to" value={t} onChange={setT} min={f} /></div>
      <Button type="submit" variant="dark" className="col-span-2"><CalendarRange /> Apply dates</Button>
    </form>
  );
}
