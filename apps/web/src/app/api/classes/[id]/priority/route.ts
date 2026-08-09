import { processingPrioritySchema } from "@aula-clara/shared";
import { dispatchProcessingJob } from "@/cloudflare/job-dispatch";
import { getApiContext } from "@/lib/auth";
import { apiError, safeJson, validationError } from "@/lib/http";
import { ownsClass } from "@/lib/ownership";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const parsed = processingPrioritySchema.safeParse(await safeJson(request));
  if (!parsed.success) return validationError(parsed.error);
  const { id } = await params;
  if (!(await ownsClass(context.supabase, id, context.user.id)))
    return apiError("Aula não encontrada.", 404, "not_found");

  if (parsed.data.priority === 100) {
    await context.supabase
      .from("classes")
      .update({ processing_priority: 50 })
      .eq("user_id", context.user.id)
      .is("study_ready_at", null)
      .neq("id", id);
    await context.supabase
      .from("processing_jobs")
      .update({ priority: 50 })
      .eq("user_id", context.user.id)
      .in("status", ["pending", "retry_wait"])
      .neq("class_id", id);
  }

  const [{ error: classError }, { error: jobsError }] = await Promise.all([
    context.supabase
      .from("classes")
      .update({ processing_priority: parsed.data.priority })
      .eq("id", id)
      .eq("user_id", context.user.id),
    context.supabase
      .from("processing_jobs")
      .update({ priority: parsed.data.priority, next_attempt_at: new Date().toISOString() })
      .eq("class_id", id)
      .eq("user_id", context.user.id)
      .in("status", ["pending", "retry_wait"])
  ]);
  if (classError || jobsError) return apiError("Não foi possível alterar a prioridade.", 500);

  await context.supabase.from("audit_events").insert({
    user_id: context.user.id,
    class_id: id,
    action: "processing.priority_changed",
    resource_type: "class",
    resource_id: id,
    metadata: { priority: parsed.data.priority }
  });
  const { data: nextJob } = await context.supabase
    .from("processing_jobs")
    .select("id")
    .eq("class_id", id)
    .eq("user_id", context.user.id)
    .in("status", ["pending", "retry_wait"])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (nextJob) {
    try {
      await dispatchProcessingJob(nextJob.id);
    } catch {
      console.error(JSON.stringify({ event: "priority.dispatch_failed", job_id: nextJob.id }));
    }
  }
  return Response.json({ data: { priority: parsed.data.priority } });
}
