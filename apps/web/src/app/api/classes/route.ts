import { classSchema } from "@aula-clara/shared";
import { getApiContext } from "@/lib/auth";
import { apiError, safeJson, validationError } from "@/lib/http";

export async function POST(request: Request) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente para continuar.", 401, "unauthorized");
  const parsed = classSchema.safeParse(await safeJson(request));
  if (!parsed.success) return validationError(parsed.error);
  const { data: subject } = await context.supabase
    .from("subjects")
    .select("id")
    .eq("id", parsed.data.subject_id)
    .eq("user_id", context.user.id)
    .maybeSingle();
  if (!subject) return apiError("Disciplina não encontrada.", 404, "not_found");
  const payload = {
    ...parsed.data,
    teacher_name: parsed.data.teacher_name || null,
    user_id: context.user.id
  };
  const { data, error } = await context.supabase
    .from("classes")
    .insert(payload)
    .select("id,title,status,progress")
    .single();
  if (error) return apiError("Não foi possível criar a aula.", 500);
  await context.supabase.from("audit_events").insert({
    user_id: context.user.id,
    class_id: data.id,
    action: "class.created",
    resource_type: "class",
    resource_id: data.id
  });
  return Response.json({ data }, { status: 201 });
}
