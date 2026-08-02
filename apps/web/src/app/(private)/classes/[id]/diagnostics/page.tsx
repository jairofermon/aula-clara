import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export default async function DiagnosticsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const supabase = await createClient();
  const { data: klass } = await supabase
    .from("classes")
    .select("id,title,status,progress,current_stage,error_message,created_at,updated_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!klass) notFound();
  const [{ data: jobs }, { data: files }, { data: chunks }, { data: usage }] = await Promise.all([
    supabase
      .from("processing_jobs")
      .select(
        "id,job_type,status,stage,progress,attempt_count,max_attempts,error_code,error_message,started_at,finished_at,updated_at"
      )
      .eq("class_id", id)
      .order("created_at"),
    supabase
      .from("class_files")
      .select(
        "id,file_type,original_name,mime_type,size_bytes,duration_ms,sha256,upload_completed,created_at"
      )
      .eq("class_id", id)
      .order("created_at"),
    supabase
      .from("audio_chunks")
      .select("id,chunk_index,start_ms,end_ms,size_bytes,status,created_at")
      .eq("class_id", id)
      .order("chunk_index"),
    supabase
      .from("usage_records")
      .select(
        "provider,model_name,operation_type,input_units,output_units,audio_seconds,estimated_cost,request_id,duration_ms,created_at"
      )
      .eq("class_id", id)
      .order("created_at")
  ]);
  return (
    <main className="mx-auto max-w-6xl px-5 py-9">
      <p className="font-bold text-[#176b58]">Diagnóstico do proprietário</p>
      <h1 className="mt-1 text-3xl font-black">{klass.title}</h1>
      <p className="mt-2 text-sm text-[#61736f]">
        IDs, tentativas e métricas; nenhum conteúdo integral é exibido nos logs.
      </p>
      {[
        { title: "Trabalhos", value: jobs },
        { title: "Arquivos", value: files },
        { title: "Blocos", value: chunks },
        { title: "Uso e custos", value: usage }
      ].map((section) => (
        <section className="mt-7" key={section.title}>
          <h2 className="text-xl font-black">{section.title}</h2>
          <div className="card mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b bg-slate-50">
                <tr>
                  {Object.keys(section.value?.[0] ?? { estado: "" }).map((key) => (
                    <th className="p-3" key={key}>
                      {key}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(section.value ?? []).map((row, index) => (
                  <tr className="border-b last:border-0" key={index}>
                    {Object.values(row).map((value, cell) => (
                      <td className="max-w-64 truncate p-3" key={cell}>
                        {value == null
                          ? "—"
                          : typeof value === "object"
                            ? JSON.stringify(value)
                            : String(value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </main>
  );
}
