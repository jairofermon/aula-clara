"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";

interface Subject {
  id: string;
  name: string;
  description: string;
  class_count: number;
  owner_name?: string;
}

export function SubjectManager({ initialSubjects }: { initialSubjects: Subject[] }) {
  const router = useRouter();
  const [subjects, setSubjects] = useState(initialSubjects);
  const [message, setMessage] = useState("");

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const response = await fetch("/api/subjects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: form.get("name"), description: form.get("description") })
    });
    const payload = (await response.json()) as { data?: Subject; error?: { message: string } };
    if (!response.ok || !payload.data) {
      setMessage(payload.error?.message ?? "Não foi possível criar a disciplina.");
      return;
    }
    setSubjects((current) => [...current, { ...payload.data!, class_count: 0 }]);
    formElement.reset();
    setMessage("Disciplina criada.");
    router.refresh();
  }

  async function remove(subject: Subject) {
    if (subject.class_count > 0) {
      setMessage("Mova ou exclua as aulas antes de remover esta disciplina.");
      return;
    }
    if (!window.confirm(`Excluir definitivamente a disciplina "${subject.name}"?`)) return;
    const response = await fetch(`/api/subjects/${subject.id}`, { method: "DELETE" });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: { message: string } };
      setMessage(payload.error?.message ?? "Não foi possível excluir.");
      return;
    }
    setSubjects((items) => items.filter((item) => item.id !== subject.id));
    setMessage("Disciplina excluída com segurança.");
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <form className="card space-y-4 p-6" onSubmit={(event) => void create(event)}>
        <div>
          <h2 className="text-xl font-black">Nova disciplina</h2>
          <p className="mt-1 text-sm text-[#61736f]">Use um nome curto e reconhecível.</p>
        </div>
        <label>
          <span className="label">Nome</span>
          <input className="field" name="name" required minLength={2} maxLength={120} />
        </label>
        <label>
          <span className="label">Descrição</span>
          <textarea className="field min-h-24" name="description" maxLength={2000} />
        </label>
        <button className="btn btn-primary w-full">
          <Plus size={17} aria-hidden /> Criar disciplina
        </button>
        {message && (
          <p role="status" className="text-sm text-[#61736f]">
            {message}
          </p>
        )}
      </form>
      <div className="space-y-3">
        {subjects.map((subject) => (
          <article className="card flex items-center justify-between gap-4 p-5" key={subject.id}>
            <a href={`/subjects/${subject.id}`}>
              <h3 className="font-black">{subject.name}</h3>
              {subject.owner_name && (
                <p className="text-xs text-[#61736f]">Incluída por: {subject.owner_name}</p>
              )}
              <p className="mt-1 text-sm text-[#61736f]">
                {subject.description || "Sem descrição"} · {subject.class_count} aula(s)
              </p>
            </a>
            <button
              className="btn btn-secondary"
              aria-label={`Excluir ${subject.name}`}
              onClick={() => void remove(subject)}
            >
              <Trash2 size={17} aria-hidden /> Excluir
            </button>
          </article>
        ))}
        {!subjects.length && (
          <div className="card p-8 text-center text-[#61736f]">
            Crie a primeira disciplina para cadastrar uma aula.
          </div>
        )}
      </div>
    </div>
  );
}
