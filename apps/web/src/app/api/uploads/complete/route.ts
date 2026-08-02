import { z } from "zod";
import { getApiContext } from "@/lib/auth";
import { apiError, safeJson, validationError } from "@/lib/http";

const schema = z.object({ file_id: z.uuid() });

export async function POST(request: Request) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const parsed = schema.safeParse(await safeJson(request));
  if (!parsed.success) return validationError(parsed.error);
  const { data: file } = await context.supabase
    .from("class_files")
    .select("id,class_id,file_type,storage_path,upload_completed")
    .eq("id", parsed.data.file_id)
    .eq("user_id", context.user.id)
    .maybeSingle();
  if (!file) return apiError("Upload não encontrado.", 404, "not_found");
  if (file.upload_completed) return Response.json({ data: file });
  const bucket = file.file_type === "audio" ? "class-audio" : "class-materials";
  const parts = file.storage_path.split("/");
  const filename = parts.pop();
  const folder = parts.join("/");
  const { data: objects, error: storageError } = await context.supabase.storage
    .from(bucket)
    .list(folder, { search: filename, limit: 10 });
  if (storageError || !objects?.some((item) => item.name === filename))
    return apiError(
      "O arquivo ainda não chegou completo ao armazenamento. Tente enviar novamente.",
      409,
      "upload_incomplete"
    );
  const { data, error } = await context.supabase
    .from("class_files")
    .update({ upload_completed: true })
    .eq("id", file.id)
    .eq("user_id", context.user.id)
    .select("id,class_id,file_type")
    .single();
  if (error) return apiError("Não foi possível concluir o upload.", 500);
  await context.supabase.from("audit_events").insert({
    user_id: context.user.id,
    class_id: file.class_id,
    action: "file.uploaded",
    resource_type: "class_file",
    resource_id: file.id,
    metadata: { file_type: file.file_type }
  });
  return Response.json({ data });
}
