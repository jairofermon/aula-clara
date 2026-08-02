import { getApiContext } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { ownsClass } from "@/lib/ownership";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const { id } = await params;
  if (!(await ownsClass(context.supabase, id, context.user.id)))
    return apiError("Aula não encontrada.", 404, "not_found");
  const { data: audio } = await context.supabase
    .from("class_files")
    .select("id")
    .eq("class_id", id)
    .eq("user_id", context.user.id)
    .eq("file_type", "audio")
    .eq("upload_completed", true)
    .maybeSingle();
  if (!audio) return apiError("Envie e conclua o áudio antes de iniciar.", 409, "audio_missing");
  const idempotencyKey = `prepare_audio:${id}:${audio.id}`;
  const { data: job, error } = await context.supabase
    .from("processing_jobs")
    .upsert(
      {
        class_id: id,
        user_id: context.user.id,
        job_type: "prepare_audio",
        status: "pending",
        stage: "queued",
        idempotency_key: idempotencyKey,
        input_json: { source_file_id: audio.id }
      },
      { onConflict: "idempotency_key", ignoreDuplicates: true }
    )
    .select("id,status")
    .maybeSingle();
  if (error) return apiError("Não foi possível registrar o processamento.", 500);
  await context.supabase
    .from("classes")
    .update({
      status: "queued",
      progress: 0,
      current_stage: "Aguardando worker",
      error_message: null
    })
    .eq("id", id)
    .eq("user_id", context.user.id);
  await context.supabase.from("audit_events").insert({
    user_id: context.user.id,
    class_id: id,
    action: "processing.started",
    resource_type: "processing_job",
    resource_id: job?.id
  });
  return Response.json({ data: job ?? { status: "already_queued" } }, { status: 202 });
}
