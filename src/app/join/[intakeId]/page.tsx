import { notFound } from "next/navigation";
import { currentStudent, deviceSuggestion } from "@/server/auth/student";
import { publicIntakes } from "@/server/services/catalog";
import { EntryForm } from "@/app/_entry/entry-form";

export const dynamic = "force-dynamic";

export default async function ProgrammeEntryPage({ params }: { params: Promise<{ intakeId: string }> }) {
  const { intakeId } = await params;
  const courses = await publicIntakes();
  const selected = courses.find((course) => course.intakeId === intakeId);
  if (!selected) notFound();

  const [device, signedIn] = await Promise.all([deviceSuggestion(), currentStudent()]);
  return <EntryForm courses={[selected]} device={device} signedIn={!!signedIn} fixedIntakeId={selected.intakeId} />;
}
