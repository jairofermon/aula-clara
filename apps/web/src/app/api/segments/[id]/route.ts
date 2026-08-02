import { segmentUpdateSchema } from "@aula-clara/shared";
import { getApiContext } from "@/lib/auth";
import { apiError, safeJson, validationError } from "@/lib/http";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const parsed = segmentUpdateSchema.safeParse(await safeJson(request));
  if (!parsed.success) return validationError(parsed.error);
  const { id } = await params;
  const { data: existing } = await context.supabase
    .from("transcript_segments")
    .select("id,class_id,raw_text,revised_text,issues:transcript_issues(id,proposed_text,status)")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return apiError("Segmento não encontrado.", 404, "not_found");
  let revisedText = parsed.data.revised_text ?? existing.revised_text ?? existing.raw_text;
  let reviewStatus: "user_edited" | "user_confirmed" = "user_edited";
  let userConfirmed = false;
  if (parsed.data.action === "keep_original") {
    revisedText = existing.raw_text;
    reviewStatus = "user_confirmed";
    userConfirmed = true;
  }
  if (parsed.data.action === "confirm") {
    reviewStatus = "user_confirmed";
    userConfirmed = true;
  }
  if (parsed.data.action === "accept_suggestion") {
    const issue = (
      existing.issues as { proposed_text: string | null; status: string }[] | null
    )?.find((item) => item.status === "open" && item.proposed_text);
    revisedText = issue?.proposed_text ?? revisedText;
    reviewStatus = "user_confirmed";
    userConfirmed = true;
  }
  const { data, error } = await context.supabase
    .from("transcript_segments")
    .update({
      revised_text: revisedText,
      review_status: reviewStatus,
      user_confirmed: userConfirmed
    })
    .eq("id", id)
    .select("id,revised_text,review_status,user_confirmed")
    .single();
  if (error) return apiError("Não foi possível salvar o segmento.", 500);
  if (userConfirmed)
    await context.supabase
      .from("transcript_issues")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("transcript_segment_id", id)
      .eq("status", "open");
  if (userConfirmed) {
    const [{ count: openIssues }, { count: unresolvedSegments }] = await Promise.all([
      context.supabase
        .from("transcript_issues")
        .select("id", { count: "exact", head: true })
        .eq("class_id", existing.class_id)
        .eq("status", "open"),
      context.supabase
        .from("transcript_segments")
        .select("id", { count: "exact", head: true })
        .eq("class_id", existing.class_id)
        .in("review_status", ["unreviewed", "needs_review"])
    ]);
    if ((openIssues ?? 0) === 0 && (unresolvedSegments ?? 0) === 0) {
      await Promise.all([
        context.supabase
          .from("classes")
          .update({
            status: "completed",
            progress: 100,
            current_stage: "Transcrição validada",
            error_message: null
          })
          .eq("id", existing.class_id)
          .eq("user_id", context.user.id),
        context.supabase
          .from("transcript_versions")
          .update({ status: "validated" })
          .eq("class_id", existing.class_id)
      ]);
    }
  }
  await context.supabase.from("audit_events").insert({
    user_id: context.user.id,
    class_id: existing.class_id,
    action: `segment.${parsed.data.action}`,
    resource_type: "transcript_segment",
    resource_id: id
  });
  return Response.json({ data });
}
