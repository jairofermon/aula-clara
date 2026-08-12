import { createClient } from "@/lib/supabase/server";
import { ClassCreateForm } from "@/components/class-create-form";
import { getServerEnv } from "@/lib/env";
import { requireUser } from "@/lib/auth";

export default async function NewClassPage({
  searchParams
}: {
  searchParams: Promise<{ subject?: string }>;
}) {
  const user = await requireUser();
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  let subjectsQuery = supabase.from("subjects").select("id,name").order("name");
  if (profile?.role !== "admin") subjectsQuery = subjectsQuery.eq("user_id", user.id);
  const { data } = await subjectsQuery;
  const query = await searchParams;
  const { maxAudioUploadBytes } = getServerEnv();
  return (
    <main className="mx-auto max-w-6xl px-5 py-9">
      <p className="font-bold text-[#176b58]">Nova aula</p>
      <h1 className="mt-1 text-4xl font-black">Envie a gravação</h1>
      <p className="mt-2 mb-8 text-[#61736f]">
        O arquivo vai direto para o armazenamento privado; nenhum segredo de processamento passa
        pelo navegador.
      </p>
      {data?.length ? (
        <ClassCreateForm
          subjects={data}
          defaultSubject={query.subject}
          maxAudioUploadBytes={maxAudioUploadBytes}
        />
      ) : (
        <div className="card p-8">Crie uma disciplina antes de cadastrar uma aula.</div>
      )}
    </main>
  );
}
