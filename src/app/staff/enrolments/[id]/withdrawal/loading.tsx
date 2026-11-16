import { PageBody } from "@/components/ui";
export default function Loading(){return <PageBody className="space-y-4"><div className="skeleton h-10 w-2/3 rounded-md"/>{[1,2,3].map(i=><div key={i} className="skeleton h-32 rounded-lg"/>)}<span className="sr-only">Loading records...</span></PageBody>;}
