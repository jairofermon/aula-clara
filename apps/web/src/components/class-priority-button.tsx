"use client";

import { Star } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ClassPriorityButton({ classId, active }: { classId: string; active: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function prioritize() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/classes/${classId}/priority`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ priority: 100 })
      });
      if (!response.ok) throw new Error("Não foi possível priorizar esta aula.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível priorizar esta aula.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={busy || active}
        onClick={() => void prioritize()}
      >
        <Star size={17} fill={active ? "currentColor" : "none"} aria-hidden />
        {active ? "Prioridade atual" : busy ? "Priorizando…" : "Estudar primeiro"}
      </button>
      {message && <p className="mt-2 text-xs text-red-700">{message}</p>}
    </div>
  );
}
