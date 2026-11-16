import { currentStudent, deviceSuggestion } from "@/server/auth/student";
import { publicIntakes } from "@/server/services/catalog";
import { EntryForm } from "./_entry/entry-form";

export const dynamic = "force-dynamic";

export default async function StudentEntryPage() {
  // Always show entry: changing course requires a new eligible NIC + intake match (spec §5).
  const [courses, device, signedIn] = await Promise.all([publicIntakes(), deviceSuggestion(), currentStudent()]);
  return <EntryForm courses={courses} device={device} signedIn={!!signedIn} />;
}
