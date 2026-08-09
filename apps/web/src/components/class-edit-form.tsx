"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type ClassValues = {
  id: string;
  title: string;
  topic: string;
  teacher_name: string | null;
  class_date: string;
  language: string;
  speaker_count: number | null;
  notes: string;
};

export function ClassEditForm({ values }: { values: ClassValues }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    const speaker = String(form.get("speaker_count") ?? "");
    const response = await fetch(`/api/classes/${values.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: form.get("title"),
        topic: form.get("topic"),
        teacher_name: form.get("teacher_name"),
        class_date: form.get("class_date"),
        language: form.get("language"),
        speaker_count: speaker ? Number(speaker) : undefined,
        notes: form.get("notes")
      })
    });
    const body = (await response.json()) as { error?: { message?: string } };
    setMessage(
      response.ok
        ? "Aula atualizada."
        : (body.error?.message ?? "Não foi possível atualizar a aula.")
    );
    if (response.ok) router.refresh();
    setBusy(false);
  }
  return (
    <form className="card grid gap-5 p-6 md:grid-cols-2" onSubmit={(event) => void submit(event)}>
      <label>
        <span className="label">Título</span>
        <input className="field" name="title" defaultValue={values.title} required />
      </label>
      <label>
        <span className="label">Assunto</span>
        <input className="field" name="topic" defaultValue={values.topic} />
      </label>
      <label>
        <span className="label">Professor</span>
        <input className="field" name="teacher_name" defaultValue={values.teacher_name ?? ""} />
      </label>
      <label>
        <span className="label">Data</span>
        <input
          className="field"
          type="date"
          name="class_date"
          defaultValue={values.class_date}
          required
        />
      </label>
      <label>
        <span className="label">Idioma</span>
        <input className="field" name="language" defaultValue={values.language} required />
      </label>
      <label>
        <span className="label">Número aproximado de falantes</span>
        <input
          className="field"
          type="number"
          min={1}
          max={20}
          name="speaker_count"
          defaultValue={values.speaker_count ?? ""}
        />
      </label>
      <label className="md:col-span-2">
        <span className="label">Observações</span>
        <textarea className="field min-h-32" name="notes" defaultValue={values.notes} />
      </label>
      {message && (
        <p role="status" className="md:col-span-2">
          {message}
        </p>
      )}
      <button className="btn btn-primary md:col-span-2" disabled={busy}>
        {busy ? "Salvando…" : "Salvar alterações"}
      </button>
    </form>
  );
}
