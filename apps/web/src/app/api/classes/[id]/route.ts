import { getApiContext } from "@/lib/auth";
import { apiError } from "@/lib/http";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const { id } = await params;
  const { data: klass } = await context.supabase
    .from("classes")
    .select("id,title")
    .eq("id", id)
    .eq("user_id", context.user.id)
    .maybeSingle();
  if (!klass) return apiError("Aula não encontrada.", 404, "not_found");

  const [{ data: files }, { data: exports }] = await Promise.all([
    context.supabase
      .from("class_files")
      .select("file_type,storage_path")
      .eq("class_id", id)
      .eq("user_id", context.user.id),
    context.supabase
      .from("materials")
      .select("storage_path")
      .eq("class_id", id)
      .eq("user_id", context.user.id)
      .not("storage_path", "is", null)
  ]);

  const audioPaths = (files ?? [])
    .filter((file) => file.file_type === "audio")
    .map((file) => file.storage_path);
  const materialPaths = (files ?? [])
    .filter((file) => file.file_type !== "audio")
    .map((file) => file.storage_path);
  const exportPaths = (exports ?? []).flatMap((item) =>
    item.storage_path ? [item.storage_path] : []
  );

  for (const [bucket, paths] of [
    ["class-audio", audioPaths],
    ["class-materials", materialPaths],
    ["generated-exports", exportPaths]
  ] as const) {
    if (!paths.length) continue;
    const { error } = await context.supabase.storage.from(bucket).remove(paths);
    if (error) return apiError("Não foi possível excluir os arquivos da aula.", 500);
  }

  await context.supabase.from("audit_events").insert({
    user_id: context.user.id,
    class_id: id,
    action: "class.deleted",
    resource_type: "class",
    resource_id: id,
    metadata: { title: klass.title }
  });
  const { error } = await context.supabase
    .from("classes")
    .delete()
    .eq("id", id)
    .eq("user_id", context.user.id);
  return error
    ? apiError("Não foi possível excluir a aula.", 500)
    : new Response(null, { status: 204 });
}
