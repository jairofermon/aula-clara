import type { ClassStatus } from "@aula-clara/shared";

export const STATUS_LABELS: Record<ClassStatus, string> = {
  uploaded: "Enviada",
  queued: "Aguardando processamento",
  preparing_audio: "Preparando áudio",
  transcribing: "Transcrevendo",
  reviewing: "Revisando",
  needs_user_review: "Aguardando conferência",
  generating_materials: "Gerando materiais",
  completed: "Concluída",
  failed: "Falhou"
};

export function statusTone(status: ClassStatus) {
  if (status === "failed") return "bg-red-100 text-red-800";
  if (status === "completed") return "bg-emerald-100 text-emerald-800";
  if (status === "needs_user_review") return "bg-amber-100 text-amber-900";
  return "bg-sky-100 text-sky-800";
}
