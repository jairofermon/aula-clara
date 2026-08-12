import Link from "next/link";
import { AlertTriangle, ArrowRight, BookOpen, Plus } from "lucide-react";
import type { ClassStatus } from "@aula-clara/shared";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ProgressBar } from "@/components/progress-bar";
import { ClassDeleteButton } from "@/components/class-delete-button";
import { ClassPriorityButton } from "@/components/class-priority-button";
import { STATUS_LABELS, statusTone } from "@/lib/status";

export const metadata = { title: "Painel" };

export default async function DashboardPage() {
  const user = await requireUser();
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const isAdmin = profile?.role === "admin";
  let subjectsQuery = supabase
    .from("subjects")
    .select("id,name,description,created_at")
    .order("name");
  let classesQuery = supabase
    .from("classes")
    .select(
      "id,user_id,subject_id,title,topic,status,progress,current_stage,error_message,created_at,processing_priority,study_ready_at,target_ready_at"
    )
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(20);
  if (!isAdmin) {
    subjectsQuery = subjectsQuery.eq("user_id", user.id);
    classesQuery = classesQuery.eq("user_id", user.id);
  }
  const [{ data: subjects }, { data: classes }, { data: profiles }] = await Promise.all([
    subjectsQuery,
    classesQuery,
    isAdmin ? supabase.from("profiles").select("id,display_name") : Promise.resolve({ data: [] })
  ]);
  const ownerNames = new Map((profiles ?? []).map((item) => [item.id, item.display_name]));
  const subjectNames = new Map((subjects ?? []).map((item) => [item.id, item.name]));

  return (
    <main className="mx-auto max-w-7xl px-5 py-9">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-bold text-[#176b58]">Seu espaço de estudo</p>
          <h1 className="mt-1 text-4xl font-black tracking-tight">Suas aulas</h1>
          <p className="mt-2 text-[#61736f]">
            Envie o áudio, acompanhe a transcrição e baixe o PDF para estudar no ChatGPT.
          </p>
        </div>
        <Link href="/classes/new" className="btn btn-primary">
          <Plus size={18} aria-hidden /> Nova aula
        </Link>
      </div>

      <section
        className="mt-9 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        aria-labelledby="subjects-title"
      >
        <div className="card border-dashed p-5">
          <h2 id="subjects-title" className="text-lg font-black">
            Disciplinas
          </h2>
          <p className="mt-2 text-sm text-[#61736f]">Organize aulas e vocabulário por matéria.</p>
          <Link
            className="mt-4 inline-flex items-center gap-1 font-bold text-[#176b58]"
            href="/subjects"
          >
            Gerenciar <ArrowRight size={16} aria-hidden />
          </Link>
        </div>
        {(subjects ?? []).slice(0, 5).map((subject) => (
          <Link
            key={subject.id}
            href={`/subjects/${subject.id}`}
            className="card p-5 transition hover:-translate-y-0.5"
          >
            <BookOpen size={20} className="text-[#176b58]" aria-hidden />
            <h3 className="mt-3 font-black">{subject.name}</h3>
            <p className="mt-1 line-clamp-2 text-sm text-[#61736f]">
              {subject.description || "Sem descrição"}
            </p>
          </Link>
        ))}
      </section>

      <section className="mt-10" aria-labelledby="recent-title">
        <h2 id="recent-title" className="text-2xl font-black">
          Aulas recentes
        </h2>
        {!classes?.length ? (
          <div className="card mt-4 p-8 text-center">
            <p className="font-bold">Nenhuma aula ainda.</p>
            <p className="mt-2 text-sm text-[#61736f]">
              Crie uma disciplina e envie a primeira gravação.
            </p>
          </div>
        ) : (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {classes.map((item) => {
              const status = item.status as ClassStatus;
              return (
                <article className="card p-5" key={item.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wide text-[#61736f]">
                        {subjectNames.get(item.subject_id) ?? "Disciplina"}
                      </p>
                      {isAdmin && (
                        <p className="mt-1 text-xs text-[#61736f]">
                          Incluída por: {ownerNames.get(item.user_id) || "Usuário sem nome"}
                        </p>
                      )}
                      <h3 className="mt-1 text-xl font-black">{item.title}</h3>
                      <p className="mt-1 text-sm text-[#61736f]">{item.topic}</p>
                    </div>
                    <span className={`badge ${statusTone(status)}`}>{STATUS_LABELS[status]}</span>
                  </div>
                  <div className="mt-5">
                    <ProgressBar
                      value={item.progress}
                      label={item.current_stage ?? STATUS_LABELS[status]}
                    />
                  </div>
                  {item.error_message && (
                    <p className="mt-3 flex gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-800">
                      <AlertTriangle size={17} className="shrink-0" aria-hidden />
                      {item.error_message}
                    </p>
                  )}
                  <div className="mt-5 flex flex-wrap gap-2">
                    <Link className="btn btn-primary" href={`/classes/${item.id}/transcript`}>
                      Abrir aula
                    </Link>
                    <Link className="btn btn-secondary" href={`/classes/${item.id}/diagnostics`}>
                      Diagnóstico
                    </Link>
                    <Link className="btn btn-secondary" href={`/classes/${item.id}/edit`}>
                      Editar
                    </Link>
                    {!item.study_ready_at && (
                      <ClassPriorityButton
                        classId={item.id}
                        active={item.processing_priority === 100}
                      />
                    )}
                    <ClassDeleteButton classId={item.id} title={item.title} />
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
