import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ClassStatus } from "@aula-clara/shared";
import { STATUS_LABELS, statusTone } from "@/lib/status";
import { ClassDeleteButton } from "@/components/class-delete-button";

export default async function SubjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const supabase = await createClient();
  const { data: subject } = await supabase
    .from("subjects")
    .select("id,name,description")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!subject) notFound();
  const { data: classes } = await supabase
    .from("classes")
    .select("id,title,topic,class_date,status,progress")
    .eq("subject_id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("class_date", { ascending: false });
  return (
    <main className="mx-auto max-w-5xl px-5 py-9">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-[#176b58]">Disciplina</p>
          <h1 className="mt-1 text-4xl font-black">{subject.name}</h1>
          <p className="mt-2 text-[#61736f]">{subject.description}</p>
        </div>
        <Link className="btn btn-primary" href={`/classes/new?subject=${subject.id}`}>
          Nova aula
        </Link>
      </div>
      <div className="mt-8 space-y-3">
        {(classes ?? []).map((item) => {
          const status = item.status as ClassStatus;
          return (
            <article key={item.id} className="card flex items-center justify-between gap-5 p-5">
              <Link href={`/classes/${item.id}/transcript`} className="min-w-0 flex-1">
                <h2 className="font-black">{item.title}</h2>
                <p className="mt-1 text-sm text-[#61736f]">
                  {item.topic} ·{" "}
                  {new Date(`${item.class_date}T12:00:00`).toLocaleDateString("pt-BR")}
                </p>
              </Link>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`badge ${statusTone(status)}`}>{STATUS_LABELS[status]}</span>
                <ClassDeleteButton classId={item.id} title={item.title} />
              </div>
            </article>
          );
        })}
        {!classes?.length && (
          <div className="card p-8 text-center text-[#61736f]">
            Ainda não há aulas nesta disciplina.
          </div>
        )}
      </div>
    </main>
  );
}
