"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function SubjectDeleteButton({
  subjectId,
  name,
  classCount,
  redirectTo
}: {
  subjectId: string;
  name: string;
  classCount: number;
  redirectTo?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (classCount > 0) {
      window.alert("Exclua ou mova as aulas desta disciplina antes de remover a pasta.");
      return;
    }
    if (!window.confirm(`Excluir definitivamente a disciplina "${name}"?`)) return;
    setBusy(true);
    const response = await fetch(`/api/subjects/${subjectId}`, { method: "DELETE" });
    if (!response.ok) {
      const body = (await response.json()) as { error?: { message?: string } };
      window.alert(body.error?.message ?? "Não foi possível excluir a disciplina.");
      setBusy(false);
      return;
    }
    if (redirectTo) router.push(redirectTo);
    else router.refresh();
  }

  return (
    <button className="btn btn-secondary" disabled={busy} onClick={() => void remove()}>
      <Trash2 size={17} aria-hidden /> {busy ? "Excluindo…" : "Excluir disciplina"}
    </button>
  );
}
