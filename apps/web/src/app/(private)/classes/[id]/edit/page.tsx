import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ClassEditForm } from "@/components/class-edit-form";

export const metadata = { title: "Editar aula" };

export default async function EditClassPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase
    .from("classes")
    .select("id,title,topic,teacher_name,class_date,language,speaker_count,notes")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) notFound();
  return (
    <main className="mx-auto max-w-4xl px-5 py-9">
      <h1 className="text-4xl font-black">Editar aula</h1>
      <p className="mt-2 mb-7 text-[#61736f]">
        Atualize os dados da aula sem alterar os arquivos ou a transcrição.
      </p>
      <ClassEditForm values={data} />
    </main>
  );
}
