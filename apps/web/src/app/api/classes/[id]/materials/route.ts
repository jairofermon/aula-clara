import { materialRequestSchema } from "@aula-clara/shared";
import { PROMPT_VERSIONS } from "@aula-clara/prompts";
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
  const [{ data: klass }, { count: openIssues }, { count: unreviewed }] = await Promise.all([
    context.supabase
      .from("classes")
      .select("transcript_version")
      .eq("id", id)
      .eq("user_id", context.user.id)
      .single(),
    context.supabase
      .from("transcript_issues")
      .select("id", { count: "exact", head: true })
      .eq("class_id", id)
      .eq("status", "open"),
    context.supabase
      .from("transcript_segments")
      .select("id", { count: "exact", head: true })
      .eq("class_id", id)
      .in("review_status", ["unreviewed", "needs_review"])
  ]);
  if (!klass || klass.transcript_version < 1)
    return apiError("A transcrição ainda não está disponível.", 409, "transcript_missing");
  if ((openIssues ?? 0) > 0 || (unreviewed ?? 0) > 0)
    return apiError(
      "Confirme as pendências da transcrição antes de gerar materiais.",
      409,
      "review_required"
    );
  const type = parsed.data.material_type;
  const { data: latest } = await context.supabase
    .from("materials")
    .select("version,status")
    .eq("class_id", id)
    .eq("material_type", type)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest?.status === "pending" || latest?.status === "generating")
    return Response.json({ data: latest }, { status: 202 });
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
      model_name: "configured-by-worker"
    })
    .select("id,material_type,status,version")
    .single();
  if (error || !material) return apiError("Não foi possível registrar o material.", 500);
  const { error: jobError } = await context.supabase.from("processing_jobs").insert({
    class_id: id,
    user_id: context.user.id,
    job_type: jobType,
    status: "pending",
    stage: "queued",
    idempotency_key: `${jobType}:${id}:t${klass.transcript_version}:v${version}`,
    input_json: { material_id: material.id, transcript_version: klass.transcript_version }
  });
  if (jobError)
    return apiError("O material foi registrado, mas a fila falhou. Use repetir etapa.", 500);
  await context.supabase
    .from("classes")
    .update({ status: "generating_materials", current_stage: `Gerando ${type}` })
    .eq("id", id)
    .eq("user_id", context.user.id);
  return Response.json({ data: material }, { status: 202 });
}
