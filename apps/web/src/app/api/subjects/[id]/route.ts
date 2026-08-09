import { subjectSchema } from "@aula-clara/shared";
import { getApiContext } from "@/lib/auth";
import { apiError, safeJson, validationError } from "@/lib/http";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const parsed = subjectSchema.partial().safeParse(await safeJson(request));
  if (!parsed.success) return validationError(parsed.error);
  const { id } = await params;
  const { data, error } = await context.supabase
    .from("subjects")
    .update(parsed.data)
    .eq("id", id)
    .select("id,name,description")
    .maybeSingle();
  return error || !data
    ? apiError("Disciplina não encontrada.", 404, "not_found")
    : Response.json({ data });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const { id } = await params;
  const { count } = await context.supabase
    .from("classes")
    .select("id", { count: "exact", head: true })
    .eq("subject_id", id)
    .is("deleted_at", null);
  if ((count ?? 0) > 0)
    return apiError(
      "Esta disciplina ainda possui aulas. Mova ou exclua as aulas antes.",
      409,
      "not_empty"
    );
  const { error } = await context.supabase.from("subjects").delete().eq("id", id);
  return error
    ? apiError("Não foi possível excluir a disciplina.", 500)
    : new Response(null, { status: 204 });
}
