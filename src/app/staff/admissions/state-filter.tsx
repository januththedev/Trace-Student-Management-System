"use client";
import { useState } from "react";
import { Filter } from "lucide-react";
import { Button, Field } from "@/components/ui";
import { Select } from "@/components/ui/kit";

const STATES = ["DRAFT", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "WAITLISTED", "WITHDRAWN"];

export function StateFilter({ initial }: { initial?: string }) {
  const [state, setState] = useState(initial ?? "");
  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      <Field htmlFor="state" label="Application state">
        <input type="hidden" name="state" value={state} />
        <Select id="state" value={state} onValueChange={setState}
          options={[{ value: "", label: "All states" }, ...STATES.map((s) => ({ value: s, label: s.replaceAll("_", " ") }))]} />
      </Field>
      <Button type="submit" variant="secondary"><Filter /> Filter applications</Button>
    </form>
  );
}
