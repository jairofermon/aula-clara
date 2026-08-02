import { z } from "zod";
import { getApiContext } from "@/lib/auth";
import { apiError, safeJson, validationError } from "@/lib/http";

const schema = z.object({ status: z.enum(["resolved", "dismissed"]) });

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const parsed = schema.safeParse(await safeJson(request));
  if (!parsed.success) return validationError(parsed.error);
  const { id } = await params;
  const { data, error } = await context.supabase
    .from("transcript_issues")
    .update({ status: parsed.data.status, resolved_at: new Date().toISOString() })
    .eq("id", id)
    .select("id,status")
    .maybeSingle();
  return error || !data
    ? apiError("Pendência não encontrada.", 404, "not_found")
    : Response.json({ data });
}
