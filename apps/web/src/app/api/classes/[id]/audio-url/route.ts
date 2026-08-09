import { getApiContext } from "@/lib/auth";
import { getServerEnv } from "@/lib/env";
import { apiError } from "@/lib/http";
import { ownsClass } from "@/lib/ownership";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const { id } = await params;
  if (!(await ownsClass(context.supabase, id)))
    return apiError("Aula não encontrada.", 404, "not_found");
  const { data: file } = await context.supabase
    .from("class_files")
    .select("storage_path,duration_ms")
    .eq("class_id", id)
    .eq("user_id", context.user.id)
    .eq("file_type", "audio")
    .eq("upload_completed", true)
    .maybeSingle();
  if (!file) return apiError("Áudio não encontrado.", 404, "not_found");
  const { data, error } = await context.supabase.storage
    .from("class-audio")
    .createSignedUrl(file.storage_path, getServerEnv().signedUrlTtl);
  return error || !data
    ? apiError("Não foi possível autorizar o áudio.", 500)
    : Response.json({
        data: {
          url: data.signedUrl,
          duration_ms: file.duration_ms,
          expires_in: getServerEnv().signedUrlTtl
        }
      });
}
