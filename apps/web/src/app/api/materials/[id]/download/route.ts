import { NextResponse } from "next/server";
import { getApiContext } from "@/lib/auth";
import { getServerEnv } from "@/lib/env";
import { apiError } from "@/lib/http";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const { id } = await params;
  const { data: material } = await context.supabase
    .from("materials")
    .select("storage_path")
    .eq("id", id)
    .eq("user_id", context.user.id)
    .eq("status", "completed")
    .maybeSingle();
  if (!material?.storage_path)
    return apiError("Exportação ainda não está disponível.", 404, "not_found");
  const { data, error } = await context.supabase.storage
    .from("generated-exports")
    .createSignedUrl(material.storage_path, getServerEnv().signedUrlTtl, { download: true });
  return error || !data
    ? apiError("Não foi possível autorizar o download.", 500)
    : NextResponse.redirect(data.signedUrl);
}
