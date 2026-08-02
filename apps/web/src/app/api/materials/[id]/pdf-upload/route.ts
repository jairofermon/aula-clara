import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getApiContext } from "@/lib/auth";
import { apiError, safeJson, validationError } from "@/lib/http";

const completionSchema = z.object({ action: z.enum(["complete", "fail"]) }).strict();

async function findPdfJob(
  supabase: NonNullable<Awaited<ReturnType<typeof getApiContext>>>["supabase"],
  materialId: string,
  classId: string,
  userId: string
) {
  const { data } = await supabase
    .from("processing_jobs")
    .select("id")
    .eq("class_id", classId)
    .eq("user_id", userId)
    .eq("job_type", "generate_pdf")
    .contains("input_json", { material_id: materialId })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const { id } = await params;
  const { data: material } = await context.supabase
    .from("materials")
    .select("id,class_id,user_id,status,version,source_transcript_version,storage_path")
    .eq("id", id)
    .eq("user_id", context.user.id)
    .eq("material_type", "pdf")
    .maybeSingle();
  if (!material) return apiError("Exportação não encontrada.", 404, "not_found");

  const [{ data: klass }, { data: transcript }] = await Promise.all([
    context.supabase
      .from("classes")
      .select("id,subject_id,title,class_date,transcript_version")
      .eq("id", material.class_id)
      .eq("user_id", context.user.id)
      .single(),
    context.supabase
      .from("transcript_segments")
      .select("start_ms,end_ms,speaker_label,raw_text,revised_text,sequence_number")
      .eq("class_id", material.class_id)
      .eq("transcript_version", material.source_transcript_version)
      .order("sequence_number")
  ]);
  if (!klass || !transcript?.length)
    return apiError(
      "A transcrição corrigida ainda não está disponível.",
      409,
      "transcript_missing"
    );
  const { data: subject } = await context.supabase
    .from("subjects")
    .select("name")
    .eq("id", klass.subject_id)
    .eq("user_id", context.user.id)
    .single();
  if (!subject) return apiError("Disciplina não encontrada.", 404, "not_found");

  const storagePath =
    material.storage_path ??
    `${context.user.id}/${material.class_id}/transcricao-v${material.version}-${randomUUID()}.pdf`;
  const { error: updateError } = await context.supabase
    .from("materials")
    .update({ status: "generating", storage_path: storagePath, error_message: null })
    .eq("id", material.id)
    .eq("user_id", context.user.id);
  if (updateError) return apiError("Não foi possível preparar o PDF.", 500);

  const pdfJob = await findPdfJob(
    context.supabase,
    material.id,
    material.class_id,
    context.user.id
  );
  if (pdfJob) {
    await context.supabase
      .from("processing_jobs")
      .update({ stage: "browser_rendering", progress: 50, locked_at: new Date().toISOString() })
      .eq("id", pdfJob.id)
      .eq("user_id", context.user.id);
  }

  const { data: signed, error: signedError } = await context.supabase.storage
    .from("generated-exports")
    .createSignedUploadUrl(storagePath, { upsert: true });
  if (signedError || !signed) return apiError("Não foi possível autorizar o PDF privado.", 500);

  return Response.json({
    data: {
      signed_url: signed.signedUrl,
      class_title: klass.title,
      subject_name: subject.name,
      class_date: klass.class_date,
      transcript_version: material.source_transcript_version,
      transcript: transcript.map((segment) => ({
        start_ms: segment.start_ms,
        end_ms: segment.end_ms,
        speaker_label: segment.speaker_label,
        text: segment.revised_text ?? segment.raw_text
      }))
    }
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const parsed = completionSchema.safeParse(await safeJson(request));
  if (!parsed.success) return validationError(parsed.error);
  const { id } = await params;
  const { data: material } = await context.supabase
    .from("materials")
    .select("id,class_id,user_id,status,source_transcript_version,storage_path")
    .eq("id", id)
    .eq("user_id", context.user.id)
    .eq("material_type", "pdf")
    .maybeSingle();
  if (!material) return apiError("Exportação não encontrada.", 404, "not_found");

  if (parsed.data.action === "fail") {
    const pdfJob = await findPdfJob(
      context.supabase,
      material.id,
      material.class_id,
      context.user.id
    );
    await Promise.all([
      context.supabase
        .from("materials")
        .update({ status: "failed", error_message: "O navegador não conseguiu gerar o PDF." })
        .eq("id", material.id)
        .eq("user_id", context.user.id),
      ...(pdfJob
        ? [
            context.supabase
              .from("processing_jobs")
              .update({
                status: "failed",
                stage: "failed",
                error_code: "browser_pdf_failed",
                error_message: "O navegador não conseguiu gerar o PDF.",
                finished_at: new Date().toISOString(),
                locked_at: null,
                locked_by: null
              })
              .eq("id", pdfJob.id)
              .eq("user_id", context.user.id)
          ]
        : [])
    ]);
    return Response.json({ data: { status: "failed" } });
  }

  if (!material.storage_path)
    return apiError("O destino do PDF não foi preparado.", 409, "upload_not_started");
  const parts = material.storage_path.split("/");
  const filename = parts.pop();
  const folder = parts.join("/");
  const { data: objects, error: storageError } = await context.supabase.storage
    .from("generated-exports")
    .list(folder, { search: filename, limit: 10 });
  if (storageError || !objects?.some((item) => item.name === filename))
    return apiError("O PDF ainda não chegou completo ao armazenamento.", 409, "upload_incomplete");

  const { error } = await context.supabase
    .from("materials")
    .update({
      status: "completed",
      structured_content: {
        kind: "corrected-transcript-pdf",
        source_transcript_version: material.source_transcript_version,
        renderer: "pdf-lib-browser"
      },
      model_name: "pdf-lib-browser",
      error_message: null
    })
    .eq("id", material.id)
    .eq("user_id", context.user.id);
  if (error) return apiError("Não foi possível concluir o PDF.", 500);

  const pdfJob = await findPdfJob(
    context.supabase,
    material.id,
    material.class_id,
    context.user.id
  );
  await Promise.all([
    context.supabase
      .from("classes")
      .update({ status: "completed", progress: 100, current_stage: "PDF pronto" })
      .eq("id", material.class_id)
      .eq("user_id", context.user.id),
    ...(pdfJob
      ? [
          context.supabase
            .from("processing_jobs")
            .update({
              status: "completed",
              stage: "completed",
              progress: 100,
              output_json: {
                material_id: material.id,
                renderer: "pdf-lib-browser",
                storage_path: material.storage_path
              },
              finished_at: new Date().toISOString(),
              locked_at: null,
              locked_by: null
            })
            .eq("id", pdfJob.id)
            .eq("user_id", context.user.id)
        ]
      : []),
    context.supabase.from("audit_events").insert({
      user_id: context.user.id,
      class_id: material.class_id,
      action: "material.pdf.generated",
      resource_type: "material",
      resource_id: material.id,
      metadata: { renderer: "pdf-lib-browser" }
    })
  ]);
  return Response.json({ data: { status: "completed" } });
}
