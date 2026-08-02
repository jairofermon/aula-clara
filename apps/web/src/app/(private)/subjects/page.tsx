import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { SubjectManager } from "@/components/subject-manager";

export default async function SubjectsPage() {
  const user = await requireUser();
  const supabase = await createClient();
  const { data } = await supabase
    .from("subjects")
    .select("id,name,description,classes(count)")
    .eq("user_id", user.id)
    .order("name");
  const subjects = (data ?? []).map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
    class_count: Array.isArray(item.classes) ? Number(item.classes[0]?.count ?? 0) : 0
  }));
  return (
    <main className="mx-auto max-w-6xl px-5 py-9">
      <h1 className="text-4xl font-black">Disciplinas</h1>
      <p className="mt-2 mb-8 text-[#61736f]">
        Cada disciplina agrupa aulas e oferece contexto ao processamento.
      </p>
      <SubjectManager initialSubjects={subjects} />
    </main>
  );
}
