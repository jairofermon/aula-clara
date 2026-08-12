import type { ClassStatus } from "@aula-clara/shared";

export const STATUS_LABELS: Record<ClassStatus, string> = {
  uploaded: "Enviada",
  queued: "Aguardando processamento",
  preparing_audio: "Preparando áudio",
  transcribing: "Transcrevendo",
  reviewing: "Corrigindo transcrição",
  needs_user_review: "Transcrição pronta",
  generating_materials: "Finalizando transcrição",
  completed: "Transcrição pronta",
  failed: "Falhou"
};

export function statusTone(status: ClassStatus) {
  if (status === "failed") return "bg-red-100 text-red-800";
  if (status === "completed" || status === "needs_user_review")
    return "bg-emerald-100 text-emerald-800";
  return "bg-sky-100 text-sky-800";
}
