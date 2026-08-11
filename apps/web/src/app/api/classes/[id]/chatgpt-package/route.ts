import { chatgptImportSchema, type TranscriptSegment } from "@aula-clara/shared";
import { getApiContext } from "@/lib/auth";
import {
  buildChatgptPackage,
  buildSafeMindmapMermaid,
  CHATGPT_PACKAGE_MAX_BYTES,
  validateChatgptReferences
} from "@/lib/chatgpt-package";
import { apiError, validationError } from "@/lib/http";

function fileSlug(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 80);
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const { id } = await params;
  const { data: klass } = await context.supabase
    .from("classes")
    .select(
      "id,user_id,subject_id,title,topic,teacher_name,class_date,language,notes,glossary,transcript_version"
    )
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!klass || klass.transcript_version < 1)
    return apiError("A transcrição bruta ainda não está pronta.", 409, "transcript_missing");

  const [{ data: subject }, { data: files }, { data: segments, error: segmentError }] =
    await Promise.all([
      context.supabase.from("subjects").select("name").eq("id", klass.subject_id).maybeSingle(),
      context.supabase
        .from("class_files")
        .select("original_name,file_type,mime_type")
        .eq("class_id", id)
        .eq("user_id", klass.user_id)
        .eq("upload_completed", true)
        .in("file_type", ["slides", "supplement"]),
      context.supabase
        .from("transcript_segments")
        .select(
          "id,sequence_number,start_ms,end_ms,speaker_label,raw_text,revised_text,confidence,review_status,user_confirmed"
        )
        .eq("class_id", id)
        .eq("transcript_version", klass.transcript_version)
        .order("sequence_number")
    ]);
  if (segmentError || !segments?.length)
    return apiError("A transcrição bruta ainda não está pronta.", 409, "transcript_missing");

  const payload = buildChatgptPackage({
    classMetadata: {
      id: klass.id,
      transcript_version: klass.transcript_version,
      subject_name: subject?.name ?? "Disciplina não informada",
      title: klass.title,
      topic: klass.topic,
      teacher_name: klass.teacher_name,
      class_date: klass.class_date,
      language: klass.language,
      notes: klass.notes,
      glossary: klass.glossary
    },
    files: (files ?? []) as Array<{
      original_name: string;
      file_type: "slides" | "supplement";
      mime_type: string;
    }>,
    segments: segments as TranscriptSegment[]
  });
  const body = JSON.stringify(payload, null, 2);
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="aula-clara-${fileSlug(klass.title) || "aula"}-chatgpt.json"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const { id } = await params;
  const form = await request.formData().catch(() => null);
  const file = form?.get("result");
  if (!(file instanceof File))
    return apiError("Selecione o arquivo aula-clara-resultado.json.", 400, "file_missing");
  if (file.size > CHATGPT_PACKAGE_MAX_BYTES)
    return apiError("O resultado ultrapassa o limite seguro de 15 MB.", 413, "file_too_large");

  let unknownPayload: unknown;
  try {
    unknownPayload = JSON.parse(await file.text());
  } catch {
    return apiError("O arquivo enviado não contém JSON válido.", 422, "invalid_json");
  }
  const parsed = chatgptImportSchema.safeParse(unknownPayload);
  if (!parsed.success) return validationError(parsed.error);
  if (parsed.data.class_id !== id)
    return apiError("Este resultado pertence a outra aula.", 409, "class_mismatch");

  const { data: klass } = await context.supabase
    .from("classes")
    .select("id,transcript_version")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!klass) return apiError("Aula não encontrada.", 404, "not_found");
  if (klass.transcript_version !== parsed.data.transcript_version)
    return apiError(
      "A transcrição mudou depois que o pacote foi exportado. Gere um novo pacote.",
      409,
      "transcript_version_mismatch"
    );
  const { data: sourceSegments, error: sourceError } = await context.supabase
    .from("transcript_segments")
    .select("id,start_ms,end_ms")
    .eq("class_id", id)
    .eq("transcript_version", klass.transcript_version)
    .order("sequence_number");
  if (sourceError || !sourceSegments?.length)
    return apiError("A transcrição desta aula não está disponível.", 409, "transcript_missing");
  const referenceErrors = validateChatgptReferences(parsed.data, sourceSegments);
  if (referenceErrors.length) return apiError(referenceErrors.join(" "), 422, "invalid_references");

  const mindmap = {
    ...parsed.data.materials.mindmap,
    mermaid: buildSafeMindmapMermaid(parsed.data.materials.mindmap.root)
  };
  const materials = [
    { material_type: "notes", structured_content: parsed.data.materials.notes },
    { material_type: "summary", structured_content: parsed.data.materials.summary },
    { material_type: "flashcards", structured_content: parsed.data.materials.flashcards },
    { material_type: "questions", structured_content: parsed.data.materials.questions },
    { material_type: "mindmap", structured_content: mindmap }
  ];
  const { data: result, error } = await context.supabase.rpc("import_chatgpt_package", {
    p_class_id: id,
    p_transcript_version: klass.transcript_version,
    p_segments: parsed.data.transcript.segments,
    p_materials: materials,
    p_model_name: parsed.data.model_name,
    p_reasoning_effort: parsed.data.reasoning_effort
  });
  if (error) {
    console.error(
      JSON.stringify({
        event: "chatgpt_package.import_failed",
        class_id: id,
        error_code: error.code
      })
    );
    const publicMessage = error.message.includes("segment_coverage_mismatch")
      ? "O resultado não cobre todos os segmentos desta aula."
      : error.message.includes("transcript_version_mismatch")
        ? "A transcrição mudou. Gere e processe um novo pacote."
        : "Não foi possível importar o resultado com segurança.";
    return apiError(publicMessage, 422, "import_failed");
  }
  return Response.json({ data: result });
}
