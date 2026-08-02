import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { allowedAudioMimeTypes, uploadStartSchema } from "@aula-clara/shared";
import { getApiContext } from "@/lib/auth";
import { getServerEnv } from "@/lib/env";
import { apiError, safeJson, validationError } from "@/lib/http";
import { ownsClass } from "@/lib/ownership";

const audioExtensions = new Set([".m4a", ".mp3", ".wav", ".mp4", ".webm"]);

export async function POST(request: Request) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const parsed = uploadStartSchema.safeParse(await safeJson(request));
  if (!parsed.success) return validationError(parsed.error);
  const input = parsed.data;
  if (!(await ownsClass(context.supabase, input.class_id, context.user.id)))
    return apiError("Aula não encontrada.", 404, "not_found");
  if (input.size_bytes > getServerEnv().maxUploadBytes)
    return apiError("O arquivo excede o limite configurado.", 413, "file_too_large");
  const extension = extname(input.original_name).toLowerCase();
  if (
    input.file_type === "audio" &&
    (!audioExtensions.has(extension) || !allowedAudioMimeTypes.includes(input.mime_type as never))
  )
    return apiError(
      "Formato de áudio não aceito. Use M4A, MP3, WAV, MP4 ou WebM.",
      415,
      "invalid_file"
    );
  if (
    (input.file_type === "slides" || input.file_type === "supplement") &&
    extension !== ".pdf" &&
    input.mime_type !== "text/plain"
  )
    return apiError(
      "Material inválido. Envie PDF ou texto simples como complemento.",
      415,
      "invalid_file"
    );
  const bucket = input.file_type === "audio" ? "class-audio" : "class-materials";
  const safeExtension = extension || (input.file_type === "audio" ? ".bin" : ".pdf");
  const storagePath = `${context.user.id}/${input.class_id}/${randomUUID()}${safeExtension}`;
  const { data: file, error: insertError } = await context.supabase
    .from("class_files")
    .insert({ ...input, user_id: context.user.id, storage_path: storagePath })
    .select("id")
    .single();
  if (insertError?.code === "23505")
    return apiError("Este mesmo arquivo já foi registrado nesta aula.", 409, "duplicate_file");
  if (insertError || !file) return apiError("Não foi possível reservar o upload.", 500);
  const { data: signed, error: signedError } = await context.supabase.storage
    .from(bucket)
    .createSignedUploadUrl(storagePath);
  if (signedError || !signed) {
    await context.supabase
      .from("class_files")
      .delete()
      .eq("id", file.id)
      .eq("user_id", context.user.id);
    return apiError("Não foi possível autorizar o upload privado.", 500);
  }
  return Response.json(
    { data: { file_id: file.id, bucket, storage_path: storagePath, signed_url: signed.signedUrl } },
    { status: 201 }
  );
}
