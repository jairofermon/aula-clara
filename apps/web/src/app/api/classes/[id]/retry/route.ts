import { getApiContext } from "@/lib/auth";
import { dispatchProcessingJob } from "@/cloudflare/job-dispatch";
import { apiError } from "@/lib/http";
import { ownsClass } from "@/lib/ownership";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const { id } = await params;
  if (!(await ownsClass(context.supabase, id)))
    return apiError("Aula não encontrada.", 404, "not_found");
  const { data: failed } = await context.supabase
    .from("processing_jobs")
    .select("id,attempt_count,max_attempts")
    .eq("class_id", id)
    .eq("status", "failed")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!failed) return apiError("Não há etapa com falha para repetir.", 409, "nothing_to_retry");
  const { error } = await context.supabase
    .from("processing_jobs")
    .update({
      status: "pending",
      stage: "manual_retry",
      next_attempt_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      error_code: null,
      error_message: null,
      max_attempts: Math.min(20, Math.max(failed.max_attempts, failed.attempt_count + 8))
    })
    .eq("id", failed.id);
  if (error) return apiError("Não foi possível reagendar a etapa.", 500);
  await context.supabase
    .from("classes")
    .update({ status: "queued", current_stage: "Etapa reagendada", error_message: null })
    .eq("id", id);
  try {
    await dispatchProcessingJob(failed.id);
  } catch {
    console.error(JSON.stringify({ event: "processing_queue.dispatch_failed", job_id: failed.id }));
  }
  return Response.json({ data: { job_id: failed.id, status: "pending" } }, { status: 202 });
}
