import { notFound } from "next/navigation";
import type { ClassStatus, TranscriptSegment } from "@aula-clara/shared";
import { createClient } from "@/lib/supabase/server";
import { ClassWorkspace } from "@/components/class-workspace";

export default async function TranscriptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: klass } = await supabase
    .from("classes")
    .select(
      "id,subject_id,title,topic,class_date,status,progress,current_stage,error_message,transcript_version,processing_priority,processing_started_at,target_ready_at,study_ready_at"
    )
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!klass) notFound();
  const [{ data: subject }, { data: files }, { data: segments }] = await Promise.all([
    supabase.from("subjects").select("name").eq("id", klass.subject_id).maybeSingle(),
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
        "id,sequence_number,start_ms,end_ms,speaker_label,raw_text,revised_text,confidence,review_status,user_confirmed"
      )
      .eq("class_id", id)
      .eq("transcript_version", klass.transcript_version)
      .order("sequence_number")
  ]);
  return (
    <ClassWorkspace
      initialClass={{
        ...klass,
        status: klass.status as ClassStatus,
        subject_name: subject?.name ?? "Disciplina não informada",
        duration_ms: files?.[0]?.duration_ms ?? null
      }}
      initialSegments={(segments ?? []) as TranscriptSegment[]}
    />
  );
}
