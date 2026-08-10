import { getApiContext } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { ownsClass } from "@/lib/ownership";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getApiContext();
  if (!context) return apiError("Entre novamente.", 401, "unauthorized");
  const { id } = await params;
  if (!(await ownsClass(context.supabase, id)))
    return apiError("Aula não encontrada.", 404, "not_found");
  const [
    { data: current },
    { count: chunksTotal },
    { count: chunksCompleted },
    { data: materials }
  ] = await Promise.all([
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
      .eq("status", "completed"),
    context.supabase
      .from("materials")
      .select("status,material_type")
      .eq("class_id", id)
      .eq("user_id", context.user.id)
  ]);
  const requestedMaterials = materials ?? [];
  const completedMaterials = requestedMaterials.filter(
    (material) => material.status === "completed"
  );
  const packagePending = requestedMaterials.some((material) =>
    ["pending", "generating"].includes(material.status)
  );
  const displayed = packagePending
    ? {
        ...current,
        status: "generating_materials",
        progress: Math.min(
          99,
          96 + Math.floor((3 * completedMaterials.length) / Math.max(1, requestedMaterials.length))
        ),
        current_stage: `Gerando pacote: ${completedMaterials.length} de ${requestedMaterials.length} materiais prontos`,
        error_message: null
      }
    : { ...current, error_message: current?.progress === 100 ? null : current?.error_message };
  return Response.json({
    data: { ...displayed, chunks_total: chunksTotal ?? 0, chunks_completed: chunksCompleted ?? 0 }
  });
}
