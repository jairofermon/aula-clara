import { subjectSchema } from "@aula-clara/shared";
import { getApiContext } from "@/lib/auth";
import { apiError, safeJson, validationError } from "@/lib/http";

export async function GET() {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente para continuar.", 401, "unauthorized");
  const { data, error } = await context.supabase
    .from("subjects")
    .select("id,name,description,created_at")
    .eq("user_id", context.user.id)
    .order("name");
  return error ? apiError("Não foi possível listar as disciplinas.", 500) : Response.json({ data });
}

export async function POST(request: Request) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente para continuar.", 401, "unauthorized");
  const parsed = subjectSchema.safeParse(await safeJson(request));
  if (!parsed.success) return validationError(parsed.error);
  const { data, error } = await context.supabase
    .from("subjects")
    .insert({ ...parsed.data, user_id: context.user.id })
    .select("id,name,description,created_at")
    .single();
  if (error) return apiError("Não foi possível criar a disciplina.", 500);
  await context.supabase.from("audit_events").insert({
    user_id: context.user.id,
    action: "subject.created",
    resource_type: "subject",
    resource_id: data.id
  });
  return Response.json({ data }, { status: 201 });
}
