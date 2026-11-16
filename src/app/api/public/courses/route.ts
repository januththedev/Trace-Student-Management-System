import { NextResponse } from "next/server";
import { publicIntakes } from "@/server/services/catalog";

/** Public, intentionally cacheable course list (no private data). */
export async function GET() {
  const courses = await publicIntakes();
  return NextResponse.json({ courses }, { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } });
}
