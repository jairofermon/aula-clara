import { dispatchProcessingJob } from "@/cloudflare/job-dispatch";
import { getApiContext } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { ownsClass } from "@/lib/ownership";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const { id } = await params;
  if (!(await ownsClass(context.supabase, id)))
    return apiError("Aula não encontrada.", 404, "not_found");

  const [{ data: klass }, { data: chunks }] = await Promise.all([
    context.supabase
      .from("classes")
      .select("user_id,transcript_version,processing_priority")
      .eq("id", id)
      .single(),
    context.supabase
      .from("audio_chunks")
      .select("id,chunk_index")
      .eq("class_id", id)
      .order("chunk_index")
  ]);
  if (!klass || !chunks?.length)
    return apiError("O áudio preparado não foi encontrado.", 409, "audio_missing");

  const targetVersion = Math.max(1, klass.transcript_version + 1);
  const { data: active } = await context.supabase
    .from("processing_jobs")
    .select("id")
    .eq("class_id", id)
    .in("status", ["pending", "running", "retry_wait"])
    .contains("input_json", { repair_transcript: true })
    .limit(1)
    .maybeSingle();
  if (active)
    return Response.json(
      { data: { job_id: active.id, target_version: targetVersion } },
      { status: 202 }
    );

  await context.supabase
    .from("processing_jobs")
    .update({ status: "cancelled", locked_at: null, locked_by: null })
    .eq("class_id", id)
    .eq("job_type", "review_transcript")
    .in("status", ["pending", "running", "retry_wait"])
    .contains("input_json", { transcript_version: klass.transcript_version });

  const { data: jobs, error } = await context.supabase
    .from("processing_jobs")
    .insert(
      chunks.map((chunk) => ({
        class_id: id,
        user_id: klass.user_id,
        job_type: "transcribe_chunk" as const,
        status: "pending" as const,
        stage: "quality_retranscription",
        priority: klass.processing_priority + 20,
        max_attempts: 8,
        idempotency_key: `repair_transcribe:${id}:v${targetVersion}:c${chunk.chunk_index}`,
        input_json: {
          chunk_id: chunk.id,
          target_transcript_version: targetVersion,
          skip_primary_provider: true,
          repair_transcript: true
        }
      }))
    )
    .select("id");
  if (error || !jobs?.length) return apiError("Não foi possível iniciar a nova transcrição.", 500);

  await context.supabase
    .from("classes")
    .update({
      status: "transcribing",
      progress: 20,
      current_stage: "Refazendo transcrição com outro provedor",
      error_message: null
    })
    .eq("id", id);
  await Promise.allSettled(jobs.map((job) => dispatchProcessingJob(job.id)));
  return Response.json(
    { data: { job_ids: jobs.map((job) => job.id), target_version: targetVersion } },
    { status: 202 }
  );
}
