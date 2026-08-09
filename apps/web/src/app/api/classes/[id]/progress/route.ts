import { getApiContext } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { ownsClass } from "@/lib/ownership";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const { id } = await params;
  if (!(await ownsClass(context.supabase, id)))
    return apiError("Aula não encontrada.", 404, "not_found");
  const [{ data: current }, { count: chunksTotal }, { count: chunksCompleted }] = await Promise.all(
    [
      context.supabase
        .from("classes")
        .select(
          "status,progress,current_stage,error_message,processing_priority,processing_started_at,target_ready_at,study_ready_at"
        )
        .eq("id", id)
        .eq("user_id", context.user.id)
        .single(),
      context.supabase
        .from("audio_chunks")
        .select("id", { count: "exact", head: true })
        .eq("class_id", id),
      context.supabase
        .from("audio_chunks")
        .select("id", { count: "exact", head: true })
        .eq("class_id", id)
        .eq("status", "completed")
    ]
  );
  return Response.json({
    data: { ...current, chunks_total: chunksTotal ?? 0, chunks_completed: chunksCompleted ?? 0 }
  });
}
