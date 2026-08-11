import { materialRequestSchema } from "@aula-clara/shared";
import { PROMPT_VERSIONS } from "@aula-clara/prompts";
import { dispatchProcessingJob } from "@/cloudflare/job-dispatch";
import { getApiContext } from "@/lib/auth";
import { apiError, safeJson, validationError } from "@/lib/http";

type ApiContext = NonNullable<Awaited<ReturnType<typeof getApiContext>>>;
type MaterialRow = {
  id: string;
  material_type: string;
  status: string;
  version: number;
  prompt_version: string;
  model_name: string;
};

async function findMaterialJob(context: ApiContext, materialId: string, ownerUserId: string) {
  const { data } = await context.supabase
    .from("processing_jobs")
    .select("id,status,attempt_count,max_attempts,locked_at")
    .eq("user_id", ownerUserId)
    .contains("input_json", { material_id: materialId })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const { id } = await params;
  const { data: klass } = await context.supabase
    .from("classes")
    .select("user_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!klass) return apiError("Aula não encontrada.", 404, "not_found");
  const { data, error } = await context.supabase
    .from("materials")
    .select(
      "id,material_type,status,version,structured_content,markdown_content,storage_path,error_message,created_at"
    )
    .eq("class_id", id)
    .eq("user_id", klass.user_id)
    .order("created_at", { ascending: false });
  return error ? apiError("Não foi possível listar os materiais.", 500) : Response.json({ data });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const parsed = materialRequestSchema.safeParse(await safeJson(request));
  if (!parsed.success) return validationError(parsed.error);
  const { id } = await params;
  const { data: klass } = await context.supabase
    .from("classes")
    .select("user_id,transcript_version,study_ready_at,processing_priority")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
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
  const jobType = type === "pdf" ? "generate_pdf" : `generate_${type}`;
  const promptKey = type === "pdf" ? "notes" : type;
  const { data: existingRows } = await context.supabase
    .from("materials")
    .select("id,material_type,version,status,prompt_version,model_name")
    .eq("class_id", id)
    .eq("user_id", klass.user_id)
    .eq("material_type", type)
    .order("version", { ascending: true })
    .limit(1);
  let material = existingRows?.[0] as MaterialRow | undefined;

  const expectedPromptVersion = PROMPT_VERSIONS[promptKey as keyof typeof PROMPT_VERSIONS];
  const needsQualityRegeneration =
    material?.status === "completed" &&
    (material.prompt_version !== expectedPromptVersion ||
      material.model_name.startsWith("extractive-"));

  if (material?.status === "completed" && !needsQualityRegeneration)
    return Response.json({ data: material });

  if (!material) {
    const { data: inserted, error } = await context.supabase
      .from("materials")
      .insert({
        class_id: id,
        user_id: klass.user_id,
        material_type: type,
        status: "pending",
        version: 1,
        source_transcript_version: klass.transcript_version,
        prompt_version: PROMPT_VERSIONS[promptKey as keyof typeof PROMPT_VERSIONS],
        model_name: browserPdf ? "pdf-lib" : "provider-ranking"
      })
      .select("id,material_type,status,version,prompt_version,model_name")
      .single();
    if (error || !inserted) return apiError("Não foi possível registrar o material único.", 500);
    material = inserted;
  } else if (material.status === "failed" || needsQualityRegeneration) {
    const { error } = await context.supabase
      .from("materials")
      .update({
        status: "pending",
        error_message: null,
        structured_content: {},
        markdown_content: null,
        model_name: browserPdf ? "pdf-lib" : "provider-ranking",
        source_transcript_version: klass.transcript_version,
        prompt_version: expectedPromptVersion
      })
      .eq("id", material.id)
      .eq("user_id", klass.user_id);
    if (error) return apiError("Não foi possível retomar este material.", 500);
    material = { ...material, status: "pending" };
  }

  let job = await findMaterialJob(context, material.id, klass.user_id);
  const now = new Date().toISOString();
  const staleRunning =
    job?.status === "running" &&
    (!job.locked_at || Date.now() - new Date(job.locked_at).getTime() > 120_000);
  if (job && (["completed", "failed", "retry_wait"].includes(job.status) || staleRunning)) {
    const { error } = await context.supabase
      .from("processing_jobs")
      .update({
        status: browserPdf ? "running" : "pending",
        stage: browserPdf ? "awaiting_browser" : "queued",
        progress: browserPdf ? 25 : 0,
        next_attempt_at: now,
        finished_at: null,
        locked_at: browserPdf ? now : null,
        locked_by: browserPdf ? `browser:${context.user.id}` : null,
        error_code: null,
        error_message: null,
        max_attempts: Math.max(job.max_attempts, job.attempt_count + 4)
      })
      .eq("id", job.id)
      .eq("user_id", klass.user_id);
    if (error) return apiError("Não foi possível retomar a geração.", 500);
    job = { ...job, status: browserPdf ? "running" : "pending" };
  }

  if (!job) {
    const { data: insertedJob, error } = await context.supabase
      .from("processing_jobs")
      .insert({
        class_id: id,
        user_id: klass.user_id,
        job_type: jobType,
        status: browserPdf ? "running" : "pending",
        stage: browserPdf ? "awaiting_browser" : "queued",
        progress: browserPdf ? 25 : 0,
        attempt_count: browserPdf ? 1 : 0,
        max_attempts: browserPdf ? 4 : 12,
        priority: klass.study_ready_at
          ? Math.max(klass.processing_priority - 20, 0)
          : klass.processing_priority,
        locked_at: browserPdf ? now : null,
        locked_by: browserPdf ? `browser:${context.user.id}` : null,
        started_at: browserPdf ? now : null,
        idempotency_key: `${jobType}:${id}:canonical`,
        input_json: {
          material_id: material.id,
          transcript_version: klass.transcript_version,
          canonical: true
        }
      })
      .select("id,status,attempt_count,max_attempts,locked_at")
      .single();
    if (error || !insertedJob)
      return apiError("O material existe, mas não foi possível colocá-lo na fila.", 500);
    job = insertedJob;
  }

  if (!klass.study_ready_at) {
    await context.supabase
      .from("classes")
      .update({
        status: "generating_materials",
        current_stage: browserPdf ? "Preparando PDF" : `Gerando ${type}`
      })
      .eq("id", id)
      .eq("user_id", klass.user_id);
  }
  if (!browserPdf && ["pending", "retry_wait"].includes(job.status)) {
    try {
      await dispatchProcessingJob(job.id);
    } catch {
      console.error(JSON.stringify({ event: "processing_queue.dispatch_failed", job_id: job.id }));
    }
  }
  return Response.json(
    {
      data: {
        ...material,
        processing_job_id: job.id,
        ...(browserPdf ? { client_generation: true } : {})
      }
    },
    { status: 202 }
  );
}
