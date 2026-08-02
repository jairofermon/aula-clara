import { notFound } from "next/navigation";
import type { ClassStatus, TranscriptSegment } from "@aula-clara/shared";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ClassWorkspace } from "@/components/class-workspace";

export default async function TranscriptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const supabase = await createClient();
  const { data: klass } = await supabase
    .from("classes")
    .select("id,title,topic,status,progress,current_stage,error_message")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!klass) notFound();
  const [{ data: files }, { data: segments }] = await Promise.all([
    supabase
      .from("class_files")
      .select("duration_ms")
      .eq("class_id", id)
      .eq("file_type", "audio")
      .eq("upload_completed", true)
      .limit(1),
    supabase
      .from("transcript_segments")
      .select(
        "id,sequence_number,start_ms,end_ms,speaker_label,raw_text,revised_text,confidence,review_status,user_confirmed,issues:transcript_issues(id,transcript_segment_id,issue_type,description,proposed_text,confidence,status)"
      )
      .eq("class_id", id)
      .order("sequence_number")
  ]);
  return (
    <ClassWorkspace
      initialClass={{
        ...klass,
        status: klass.status as ClassStatus,
        duration_ms: files?.[0]?.duration_ms ?? null
      }}
      initialSegments={(segments ?? []) as TranscriptSegment[]}
    />
  );
}
