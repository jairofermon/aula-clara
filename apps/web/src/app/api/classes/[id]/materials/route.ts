import { materialRequestSchema } from "@aula-clara/shared";
import { PROMPT_VERSIONS } from "@aula-clara/prompts";
import { dispatchProcessingJob } from "@/cloudflare/job-dispatch";
import { getApiContext } from "@/lib/auth";
import { apiError, safeJson, validationError } from "@/lib/http";
import { ownsClass } from "@/lib/ownership";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const { id } = await params;
  if (!(await ownsClass(context.supabase, id, context.user.id)))
    return apiError("Aula não encontrada.", 404, "not_found");
  const { data, error } = await context.supabase
    .from("materials")
    .select(
      "id,material_type,status,version,structured_content,markdown_content,storage_path,error_message,created_at"
    )
    .eq("class_id", id)
    .eq("user_id", context.user.id)
    .order("created_at", { ascending: false });
  return error ? apiError("Não foi possível listar os materiais.", 500) : Response.json({ data });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const parsed = materialRequestSchema.safeParse(await safeJson(request));
  if (!parsed.success) return validationError(parsed.error);
  const { id } = await params;
  if (!(await ownsClass(context.supabase, id, context.user.id)))
    return apiError("Aula não encontrada.", 404, "not_found");
  const { data: klass } = await context.supabase
    .from("classes")
    .select("transcript_version,study_ready_at,processing_priority")
    .eq("id", id)
    .eq("user_id", context.user.id)
    .single();
  if (!klass || klass.transcript_version < 1)
    return apiError("A transcrição ainda não está disponível.", 409, "transcript_missing");
  const { count: unreviewed } = await context.supabase
    .from("transcript_segments")
    .select("id", { count: "exact", head: true })
    .eq("class_id", id)
    .eq("transcript_version", klass.transcript_version)
    .eq("review_status", "unreviewed");
  if ((unreviewed ?? 0) > 0)
    return apiError(
      "A correção automática da transcrição ainda está sendo concluída.",
      409,
      "transcript_processing"
    );
  const type = parsed.data.material_type;
  const browserPdf = type === "pdf" && process.env.PROCESSING_DISPATCH_MODE === "cloudflare";
  const { data: latest } = await context.supabase
    .from("materials")
    .select("id,material_type,version,status")
    .eq("class_id", id)
    .eq("material_type", type)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest?.status === "pending" || latest?.status === "generating")
    return Response.json(
      { data: { ...latest, ...(browserPdf ? { client_generation: true } : {}) } },
      { status: 202 }
    );
  const version = (latest?.version ?? 0) + 1;
  const jobType = type === "pdf" ? "generate_pdf" : `generate_${type}`;
  const promptKey = type === "pdf" ? "notes" : type;
  const { data: material, error } = await context.supabase
    .from("materials")
    .insert({
      class_id: id,
      user_id: context.user.id,
      material_type: type,
      status: "pending",
      version,
      source_transcript_version: klass.transcript_version,
      prompt_version: PROMPT_VERSIONS[promptKey as keyof typeof PROMPT_VERSIONS],
      model_name: browserPdf ? "pdf-lib-browser" : "configured-by-worker"
    })
    .select("id,material_type,status,version")
    .single();
  if (error || !material) return apiError("Não foi possível registrar o material.", 500);
  if (browserPdf) {
    const now = new Date().toISOString();
    const { data: browserJob, error: browserJobError } = await context.supabase
      .from("processing_jobs")
      .insert({
        class_id: id,
        user_id: context.user.id,
        job_type: jobType,
        status: "running",
        stage: "awaiting_browser",
        progress: 25,
        attempt_count: 1,
        max_attempts: 1,
        priority: klass.processing_priority,
        locked_at: now,
        locked_by: `browser:${context.user.id}`,
        started_at: now,
        idempotency_key: `${jobType}:${id}:t${klass.transcript_version}:v${version}`,
        input_json: {
          material_id: material.id,
          transcript_version: klass.transcript_version
        }
      })
      .select("id")
      .single();
    if (browserJobError || !browserJob) {
      await context.supabase
        .from("materials")
        .delete()
        .eq("id", material.id)
        .eq("user_id", context.user.id);
      return apiError("Não foi possível registrar a geração do PDF.", 500);
    }
    if (!klass.study_ready_at) {
      await context.supabase
        .from("classes")
        .update({ status: "generating_materials", current_stage: "Preparando PDF no navegador" })
        .eq("id", id)
        .eq("user_id", context.user.id);
    }
    return Response.json(
      {
        data: {
          ...material,
          processing_job_id: browserJob.id,
          client_generation: true
        }
      },
      { status: 202 }
    );
  }
  const { data: job, error: jobError } = await context.supabase
    .from("processing_jobs")
    .insert({
      class_id: id,
      user_id: context.user.id,
      job_type: jobType,
      status: "pending",
      stage: "queued",
      priority: klass.study_ready_at
        ? Math.max(klass.processing_priority - 20, 0)
        : klass.processing_priority,
      idempotency_key: `${jobType}:${id}:t${klass.transcript_version}:v${version}`,
      input_json: {
        material_id: material.id,
        transcript_version: klass.transcript_version
      }
    })
    .select("id")
    .single();
  if (jobError || !job)
    return apiError("O material foi registrado, mas a fila falhou. Use repetir etapa.", 500);
  if (!klass.study_ready_at) {
    await context.supabase
      .from("classes")
      .update({ status: "generating_materials", current_stage: `Gerando ${type}` })
      .eq("id", id)
      .eq("user_id", context.user.id);
  }
  try {
    await dispatchProcessingJob(job.id);
  } catch {
    console.error(JSON.stringify({ event: "processing_queue.dispatch_failed", job_id: job.id }));
  }
  return Response.json({ data: material }, { status: 202 });
}
