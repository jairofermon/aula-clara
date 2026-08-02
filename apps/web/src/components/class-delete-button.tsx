"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ClassDeleteButton({
  classId,
  title,
  redirectTo
}: {
  classId: string;
  title: string;
  redirectTo?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!window.confirm(`Excluir definitivamente a aula "${title}"?`)) return;
    setBusy(true);
    const response = await fetch(`/api/classes/${classId}`, { method: "DELETE" });
    if (!response.ok) {
      const body = (await response.json()) as { error?: { message?: string } };
      window.alert(body.error?.message ?? "Não foi possível excluir a aula.");
      setBusy(false);
      return;
    }
    if (redirectTo) router.push(redirectTo);
    else router.refresh();
  }

  return (
    <button className="btn btn-secondary" disabled={busy} onClick={() => void remove()}>
      <Trash2 size={17} aria-hidden /> {busy ? "Excluindo…" : "Excluir"}
    </button>
  );
}
