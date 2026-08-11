type MaterialState = {
  material_type: string;
  status: string;
  version: number;
};

export type PackageClassState = {
  status: "completed" | "generating_materials";
  progress: number;
  current_stage: string;
  error_message: null;
};

/**
 * Reconciles the class status after the browser PDF is persisted.
 *
 * There can be legacy v2 rows in older classes. The current product has one
 * canonical material per type, so the lowest version is the authoritative row.
 */
export function packageClassState(materials: MaterialState[]): PackageClassState {
  const canonical = new Map<string, MaterialState>();
  for (const material of [...materials].sort((a, b) => a.version - b.version)) {
    if (!canonical.has(material.material_type)) canonical.set(material.material_type, material);
  }

  const rows = [...canonical.values()];
  const completed = rows.filter((material) => material.status === "completed").length;
  const unfinished = rows.filter((material) => material.status !== "completed");

  if (unfinished.length === 0) {
    return {
      status: "completed",
      progress: 100,
      current_stage: "Pacote concluído",
      error_message: null
    };
  }

  const waitingForRetry = unfinished.some((material) => material.status === "failed");
  return {
    status: "generating_materials",
    progress: Math.min(99, 96 + Math.floor((3 * completed) / Math.max(1, rows.length))),
    current_stage: waitingForRetry
      ? `Retomando pacote: ${completed} de ${rows.length} materiais prontos`
      : `Gerando pacote: ${completed} de ${rows.length} materiais prontos`,
    error_message: null
  };
}
