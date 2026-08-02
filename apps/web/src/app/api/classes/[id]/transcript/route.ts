import { getApiContext } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { ownsClass } from "@/lib/ownership";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const { id } = await params;
  if (!(await ownsClass(context.supabase, id, context.user.id)))
    return apiError("Aula não encontrada.", 404, "not_found");
  const { data: klass } = await context.supabase
    .from("classes")
    .select("transcript_version")
    .eq("id", id)
    .eq("user_id", context.user.id)
    .single();
  if (!klass) return apiError("Aula não encontrada.", 404, "not_found");
  const { data, error } = await context.supabase
    .from("transcript_segments")
    .select(
      "id,sequence_number,start_ms,end_ms,speaker_label,raw_text,revised_text,confidence,review_status,user_confirmed"
    )
    .eq("class_id", id)
    .eq("transcript_version", klass.transcript_version)
    .order("sequence_number");
  return error
    ? apiError("Não foi possível carregar a transcrição.", 500)
    : Response.json({ data });
}
