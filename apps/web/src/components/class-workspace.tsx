"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Pause, Play, RotateCcw, Search } from "lucide-react";
import {
  flashcardsToAnkiCsv,
  formatTimestamp,
  type ClassStatus,
  type Flashcard,
  type TranscriptSegment
} from "@aula-clara/shared";
import { ProgressBar } from "@/components/progress-bar";
import { MaterialContent, materialToText } from "@/components/material-content";
import { STATUS_LABELS, statusTone } from "@/lib/status";
import { seekAudio } from "@/lib/player";

interface ClassInfo {
  id: string;
  title: string;
  topic: string;
  status: ClassStatus;
  progress: number;
  current_stage: string | null;
  error_message: string | null;
  duration_ms: number | null;
  processing_priority?: number;
  processing_started_at?: string | null;
  target_ready_at?: string | null;
  study_ready_at?: string | null;
}
interface Material {
  id: string;
  material_type: string;
  status: string;
  version: number;
  structured_content: Record<string, unknown>;
  markdown_content: string | null;
  storage_path: string | null;
  error_message: string | null;
}
interface Progress {
  status: ClassStatus;
  progress: number;
  current_stage: string | null;
  error_message: string | null;
  chunks_completed: number;
  chunks_total: number;
  processing_priority?: number;
  processing_started_at?: string | null;
  target_ready_at?: string | null;
  study_ready_at?: string | null;
}

function SegmentCard({
  segment,
  active,
  onSeek,
  onUpdated
}: {
  segment: TranscriptSegment;
  active: boolean;
  onSeek: (ms: number) => void;
  onUpdated: (item: TranscriptSegment) => void;
}) {
  const [text, setText] = useState(segment.revised_text ?? segment.raw_text);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const persist = useCallback(
    async (value = text) => {
      setSaveState("saving");
      const response = await fetch(`/api/segments/${segment.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revised_text: value, action: "save" })
      });
      const payload = (await response.json()) as {
        data?: Pick<TranscriptSegment, "revised_text" | "review_status" | "user_confirmed">;
      };
      if (!response.ok || !payload.data) {
        setSaveState("error");
        return;
      }
      const updated = {
        ...segment,
        ...payload.data
      };
      setText(updated.revised_text ?? updated.raw_text);
      setDirty(false);
      setSaveState("saved");
      onUpdated(updated);
    },
    [onUpdated, segment, text]
  );

  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => void persist(), 900);
    return () => window.clearTimeout(timer);
  }, [dirty, persist, text]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  return (
    <article
      id={`segment-${segment.id}`}
      className={`h-[250px] overflow-auto rounded-xl border p-4 transition ${active ? "border-[#176b58] bg-[#edf5f1] shadow-md" : "border-[#dbe4df] bg-white"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            className="rounded-lg bg-[#176b58] px-2.5 py-1.5 font-mono text-sm font-bold text-white"
            onClick={() => onSeek(segment.start_ms)}
            aria-label={`Ir para ${formatTimestamp(segment.start_ms)}`}
          >
            {formatTimestamp(segment.start_ms)}
          </button>
          <span className="badge bg-slate-100 text-slate-700">
            {segment.speaker_label || "Falante não identificado"}
          </span>
          {segment.confidence != null && (
            <span className="text-xs text-[#61736f]">
              Confiança {Math.round(segment.confidence * 100)}%
            </span>
          )}
        </div>
        <span className="text-xs text-[#61736f]" aria-live="polite">
          {saveState === "saving"
            ? "Salvando…"
            : saveState === "saved"
              ? "Salvo"
              : saveState === "error"
                ? "Falha ao salvar"
                : ""}
        </span>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-bold text-[#61736f]">
          Ver transcrição original
        </summary>
        <p className="mt-2 rounded-lg bg-slate-50 p-3 text-sm leading-6">{segment.raw_text}</p>
      </details>
      <label className="mt-3 block">
        <span className="label">Transcrição corrigida</span>
        <textarea
          className="field min-h-24 resize-y leading-6"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setDirty(true);
            setSaveState("idle");
          }}
        />
      </label>
    </article>
  );
}

function VirtualTranscript({
  segments,
  activeId,
  onSeek,
  onUpdated
}: {
  segments: TranscriptSegment[];
  activeId?: string;
  onSeek: (ms: number) => void;
  onUpdated: (item: TranscriptSegment) => void;
}) {
  const rowHeight = 266;
  const [scrollTop, setScrollTop] = useState(0);
  const height = 680;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 2);
  const end = Math.min(segments.length, Math.ceil((scrollTop + height) / rowHeight) + 2);
  return (
    <div
      className="relative overflow-auto rounded-2xl"
      style={{ height }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      aria-label="Segmentos da transcrição"
    >
      <div style={{ height: segments.length * rowHeight, position: "relative" }}>
        {segments.slice(start, end).map((segment, offset) => (
          <div
            key={segment.id}
            style={{ position: "absolute", top: (start + offset) * rowHeight, left: 0, right: 0 }}
          >
            <SegmentCard
              segment={segment}
              active={segment.id === activeId}
              onSeek={onSeek}
              onUpdated={onUpdated}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ContinuousTranscript({
  segments,
  activeId,
  onSeek
}: {
  segments: TranscriptSegment[];
  activeId?: string;
  onSeek: (ms: number) => void;
}) {
  return (
    <article
      className="card max-h-[680px] overflow-auto p-5 sm:p-7"
      aria-label="Transcrição contínua"
    >
      <div className="text-[1.02rem] leading-8 text-[#243b35]">
        {segments.map((segment) => (
          <span
            className={
              segment.id === activeId
                ? "rounded bg-emerald-100 px-1 shadow-sm"
                : "transition-colors"
            }
            id={`continuous-segment-${segment.id}`}
            key={segment.id}
          >
            <button
              className="mr-2 inline-flex rounded-md bg-[#edf5f1] px-2 py-0.5 font-mono text-xs font-black text-[#176b58] hover:bg-[#d9ebe4]"
              onClick={() => onSeek(segment.start_ms)}
              aria-label={`Ouvir a partir de ${formatTimestamp(segment.start_ms)}`}
            >
              {formatTimestamp(segment.start_ms)}
            </button>
            <span>{segment.revised_text ?? segment.raw_text}</span>{" "}
          </span>
        ))}
      </div>
    </article>
  );
}

function MaterialsPanel({ classId, classTitle }: { classId: string; classTitle: string }) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [message, setMessage] = useState("");
  const [packageBusy, setPackageBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch(`/api/classes/${classId}/materials`);
    if (response.ok) {
      const body = (await response.json()) as { data: Material[] };
      setMaterials(body.data);
    }
  }, [classId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!materials.some((material) => ["pending", "generating"].includes(material.status))) return;
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, [load, materials]);
  const visibleMaterials = useMemo(() => {
    const seen = new Set<string>();
    return materials.filter((material) => {
      if (seen.has(material.material_type)) return false;
      seen.add(material.material_type);
      return true;
    });
  }, [materials]);
  async function generate(material_type: string) {
    setMessage("Registrando geração…");
    const response = await fetch(`/api/classes/${classId}/materials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ material_type })
    });
    const body = (await response.json()) as {
      data?: { id: string; client_generation?: boolean };
      error?: { message: string };
    };
    if (response.ok && body.data?.client_generation) {
      const materialId = body.data.id;
      try {
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            setMessage(
              attempt === 1
                ? "Gerando o PDF no navegador…"
                : `Retomando o PDF automaticamente (${attempt}/3)…`
            );
            const start = await fetch(`/api/materials/${materialId}/pdf-upload`, {
              method: "POST"
            });
            const startBody = (await start.json()) as {
              data?: {
                completed?: boolean;
                signed_url: string;
                class_title: string;
                subject_name: string;
                class_date: string;
                transcript_version: number;
                transcript: Array<{
                  start_ms: number;
                  end_ms: number;
                  speaker_label: string | null;
                  text: string;
                }>;
              };
              error?: { message: string };
            };
            if (!start.ok || !startBody.data)
              throw new Error(startBody.error?.message ?? "Não foi possível preparar o PDF.");
            if (startBody.data.completed) {
              setMessage("PDF pronto para download.");
              await load();
              return;
            }
            const { buildTranscriptPdf } = await import("@/lib/client-pdf");
            const bytes = await buildTranscriptPdf({
              classTitle: startBody.data.class_title,
              subjectName: startBody.data.subject_name,
              classDate: startBody.data.class_date,
              transcriptVersion: startBody.data.transcript_version,
              transcript: startBody.data.transcript
            });
            const upload = await fetch(startBody.data.signed_url, {
              method: "PUT",
              headers: { "content-type": "application/pdf", "x-upsert": "true" },
              body: new Blob([Uint8Array.from(bytes)], { type: "application/pdf" })
            });
            if (!upload.ok) throw new Error("O PDF não chegou ao armazenamento privado.");
            const complete = await fetch(`/api/materials/${materialId}/pdf-upload`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "complete" })
            });
            if (!complete.ok) throw new Error("Não foi possível confirmar o PDF.");
            setMessage("PDF pronto para download.");
            lastError = null;
            break;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error("Falha ao gerar o PDF.");
          }
        }
        if (lastError) throw lastError;
      } catch (error) {
        await fetch(`/api/materials/${materialId}/pdf-upload`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "fail" })
        });
        setMessage(error instanceof Error ? error.message : "Falha ao gerar o PDF.");
      }
    } else {
      setMessage(
        response.ok ? "Material colocado na fila." : (body.error?.message ?? "Falha ao gerar.")
      );
    }
    await load();
  }
  async function generateAll() {
    setPackageBusy(true);
    setMessage("Gerando PDF da transcrição e materiais de estudo…");
    try {
      const requests = ["notes", "summary", "flashcards", "questions", "mindmap"].map(
        async (material_type) => {
          const response = await fetch(`/api/classes/${classId}/materials`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ material_type })
          });
          if (response.ok) return;
          const body = (await response.json()) as { error?: { message?: string } };
          throw new Error(body.error?.message ?? `Falha ao solicitar ${material_type}.`);
        }
      );
      await Promise.all(requests);
      await generate("pdf");
      setMessage(
        "Pacote solicitado. O PDF já pode ser baixado e os demais materiais aparecerão assim que ficarem prontos."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao gerar o pacote completo.");
    } finally {
      setPackageBusy(false);
      await load();
    }
  }
  function exportCsv(material: Material) {
    const cards = Array.isArray(material.structured_content.flashcards)
      ? (material.structured_content.flashcards as Flashcard[])
      : [];
    const blob = new Blob(["\ufeff", flashcardsToAnkiCsv(cards)], {
      type: "text/csv;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "aula-clara-flashcards.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }
  const labels: Record<string, string> = {
    notes: "Apostila",
    summary: "Resumo",
    flashcards: "Flashcards",
    questions: "Questões",
    mindmap: "Mapa mental",
    pdf: "PDF da transcrição"
  };
  async function exportMaterialPdf(material: Material) {
    try {
      setMessage(`Gerando PDF de ${labels[material.material_type] ?? "material"}…`);
      const { buildStudyMaterialPdf } = await import("@/lib/client-pdf");
      const bytes = await buildStudyMaterialPdf({
        title: labels[material.material_type] ?? material.material_type,
        classTitle,
        text: materialToText(material.material_type, material.structured_content)
      });
      const blob = new Blob([Uint8Array.from(bytes)], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const slug = (labels[material.material_type] ?? material.material_type)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/gu, "")
        .toLocaleLowerCase("pt-BR")
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-|-$/gu, "");
      anchor.href = url;
      anchor.download = `aula-clara-${slug}.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage("PDF exportado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível exportar o PDF.");
    }
  }
  return (
    <section className="mt-10" aria-labelledby="materials-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="materials-title" className="text-2xl font-black">
            Materiais de estudo
          </h2>
          <p className="mt-1 text-sm text-[#61736f]">
            Um clique gera o PDF da transcrição corrigida e todos os materiais de estudo.
          </p>
        </div>
        {message && (
          <p role="status" className="text-sm text-[#61736f]">
            {message}
          </p>
        )}
      </div>
      <div className="mt-4">
        <button
          className="btn btn-primary"
          disabled={packageBusy}
          onClick={() => void generateAll()}
        >
          {packageBusy ? "Gerando pacote…" : "Gerar pacote completo"}
        </button>
      </div>
      <div className="mt-5 space-y-4">
        {visibleMaterials.map((material) => (
          <article className="card p-5" key={material.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-black">
                  {labels[material.material_type] ?? material.material_type}
                </h3>
                <span className="text-sm text-[#61736f]">
                  {material.status === "completed"
                    ? "Pronto"
                    : material.status === "failed"
                      ? "Falhou"
                      : "Em processamento"}
                </span>
              </div>
              <div className="flex gap-2">
                {material.status === "failed" && (
                  <button
                    className="btn btn-primary"
                    onClick={() => void generate(material.material_type)}
                  >
                    Tentar novamente
                  </button>
                )}
                {material.status === "completed" && material.material_type !== "pdf" && (
                  <button
                    className="btn btn-secondary"
                    onClick={() => void exportMaterialPdf(material)}
                  >
                    <Download size={17} aria-hidden /> Exportar PDF
                  </button>
                )}
                {material.material_type === "flashcards" && material.status === "completed" && (
                  <button className="btn btn-secondary" onClick={() => exportCsv(material)}>
                    <Download size={17} aria-hidden /> CSV Anki
                  </button>
                )}
                {material.status === "completed" && material.storage_path && (
                  <a className="btn btn-primary" href={`/api/materials/${material.id}/download`}>
                    <Download size={17} aria-hidden /> Baixar
                  </a>
                )}
              </div>
            </div>
            {material.status === "completed" && material.material_type !== "pdf" && (
              <MaterialContent
                type={material.material_type}
                content={material.structured_content}
              />
            )}
            {material.error_message && (
              <p className="mt-3 text-sm text-red-700">{material.error_message}</p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

export function ClassWorkspace({
  initialClass,
  initialSegments
}: {
  initialClass: ClassInfo;
  initialSegments: TranscriptSegment[];
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [segments, setSegments] = useState(initialSegments);
  const [progress, setProgress] = useState<Progress>({
    ...initialClass,
    chunks_completed: 0,
    chunks_total: 0
  });
  const [audioUrl, setAudioUrl] = useState("");
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(initialClass.duration_ms ?? 0);
  const [search, setSearch] = useState("");
  const [transcriptMode, setTranscriptMode] = useState<"continuous" | "segments">("continuous");

  const loadSegments = useCallback(async () => {
    const response = await fetch(`/api/classes/${initialClass.id}/transcript`);
    if (response.ok) {
      const body = (await response.json()) as { data: TranscriptSegment[] };
      setSegments(body.data);
    }
  }, [initialClass.id]);
  useEffect(() => {
    void fetch(`/api/classes/${initialClass.id}/audio-url`)
      .then(async (response) =>
        response.ok
          ? (response.json() as Promise<{ data: { url: string; duration_ms: number | null } }>)
          : null
      )
      .then((body) => {
        if (body) {
          setAudioUrl(body.data.url);
          if (body.data.duration_ms) setDurationMs(body.data.duration_ms);
        }
      });
  }, [initialClass.id]);
  useEffect(() => {
    const poll = async () => {
      if (document.hidden) return;
      const response = await fetch(`/api/classes/${initialClass.id}/progress`, {
        cache: "no-store"
      });
      if (response.ok) {
        const body = (await response.json()) as { data: Progress };
        setProgress(body.data);
        if (body.data.status === "needs_user_review" || body.data.status === "completed")
          await loadSegments();
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => window.clearInterval(timer);
  }, [initialClass.id, loadSegments]);
  const active = segments.find(
    (segment) => currentMs >= segment.start_ms && currentMs < segment.end_ms
  );
  const filtered = useMemo(
    () =>
      segments.filter((segment) => {
        const haystack =
          `${segment.raw_text} ${segment.revised_text ?? ""} ${segment.speaker_label ?? ""}`.toLocaleLowerCase(
            "pt-BR"
          );
        return haystack.includes(search.toLocaleLowerCase("pt-BR"));
      }),
    [search, segments]
  );
  function seek(ms: number) {
    if (!audioRef.current) return;
    seekAudio(audioRef.current, ms);
    setCurrentMs(ms);
    void audioRef.current.play();
  }
  function updateSegment(updated: TranscriptSegment) {
    setSegments((items) => items.map((item) => (item.id === updated.id ? updated : item)));
  }
  async function retry() {
    await fetch(`/api/classes/${initialClass.id}/retry`, { method: "POST" });
  }
  return (
    <main className="mx-auto max-w-7xl px-5 py-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-bold text-[#176b58]">Transcrição corrigida</p>
          <h1 className="mt-1 text-3xl font-black sm:text-4xl">{initialClass.title}</h1>
          <p className="mt-2 text-[#61736f]">{initialClass.topic}</p>
        </div>
        <span className={`badge ${statusTone(progress.status)}`}>
          {STATUS_LABELS[progress.status]}
        </span>
      </div>
      {progress.study_ready_at && (
        <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
          <p className="font-black">Pronta para estudar</p>
          <p className="mt-1 text-sm">
            A transcrição passou pelas duas revisões de IA e o resumo prioritário está disponível.
          </p>
        </div>
      )}
      <section className="card sticky top-3 z-20 mt-7 p-4 sm:p-5" aria-label="Player de áudio">
        <audio
          ref={audioRef}
          src={audioUrl || undefined}
          onTimeUpdate={(event) => setCurrentMs(event.currentTarget.currentTime * 1000)}
          onLoadedMetadata={(event) => setDurationMs(event.currentTarget.duration * 1000)}
          onEnded={() => setPlaying(false)}
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="grid h-11 w-11 place-items-center rounded-full bg-[#176b58] text-white"
            aria-label={playing ? "Pausar" : "Reproduzir"}
            onClick={() => {
              const player = audioRef.current;
              if (!player) return;
              if (player.paused) {
                void player.play();
                setPlaying(true);
              } else {
                player.pause();
                setPlaying(false);
              }
            }}
          >
            {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
          </button>
          <button
            className="btn btn-secondary !min-h-10"
            onClick={() => seek(Math.max(0, currentMs - 10_000))}
          >
            <RotateCcw size={17} aria-hidden /> 10 s
          </button>
          <span className="min-w-28 font-mono text-sm">
            {formatTimestamp(currentMs)} / {formatTimestamp(durationMs)}
          </span>
          <input
            className="min-w-36 flex-1 accent-[#176b58]"
            type="range"
            min={0}
            max={Math.max(1, durationMs)}
            value={Math.min(currentMs, durationMs)}
            onChange={(event) => seek(Number(event.target.value))}
            aria-label="Posição do áudio"
          />
          <label className="text-sm font-bold">
            Velocidade{" "}
            <select
              className="ml-1 rounded-lg border p-2"
              defaultValue="1"
              onChange={(event) => {
                if (audioRef.current) audioRef.current.playbackRate = Number(event.target.value);
              }}
            >
              <option value="0.75">0,75×</option>
              <option value="1">1×</option>
              <option value="1.25">1,25×</option>
              <option value="1.5">1,5×</option>
              <option value="2">2×</option>
            </select>
          </label>
        </div>
      </section>
      <section className="mt-5 grid gap-5 lg:grid-cols-[1fr_330px]">
        <div>
          <div className="mb-4 flex flex-wrap gap-3">
            <label className="relative min-w-64 flex-1">
              <Search className="absolute left-3 top-3 text-[#61736f]" size={18} aria-hidden />
              <span className="sr-only">Buscar transcrição</span>
              <input
                className="field pl-10"
                placeholder="Buscar na transcrição"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="flex rounded-xl border border-[#dbe4df] bg-white p-1" role="group">
              <button
                className={`rounded-lg px-3 py-2 text-sm font-bold ${transcriptMode === "continuous" ? "bg-[#176b58] text-white" : "text-[#176b58]"}`}
                onClick={() => setTranscriptMode("continuous")}
              >
                Leitura contínua
              </button>
              <button
                className={`rounded-lg px-3 py-2 text-sm font-bold ${transcriptMode === "segments" ? "bg-[#176b58] text-white" : "text-[#176b58]"}`}
                onClick={() => setTranscriptMode("segments")}
              >
                Editar por trecho
              </button>
            </div>
          </div>
          <p className="mb-4 text-sm text-[#61736f]">
            A correção é automática. Use os timestamps para consultar o áudio original quando quiser
            conferir o contexto.
          </p>
          {filtered.length && transcriptMode === "continuous" ? (
            <ContinuousTranscript segments={filtered} activeId={active?.id} onSeek={seek} />
          ) : filtered.length ? (
            <VirtualTranscript
              segments={filtered}
              activeId={active?.id}
              onSeek={seek}
              onUpdated={updateSegment}
            />
          ) : (
            <div className="card p-8 text-center text-[#61736f]">
              {segments.length
                ? "Nenhum segmento corresponde ao filtro."
                : "A transcrição aparecerá aqui quando os primeiros blocos forem consolidados."}
            </div>
          )}
        </div>
        <aside className="card h-fit p-5">
          <h2 className="font-black">Processamento</h2>
          <div className="mt-4">
            <ProgressBar
              value={progress.progress}
              label={progress.current_stage ?? STATUS_LABELS[progress.status]}
            />
          </div>
          {progress.chunks_total > 0 && (
            <p className="mt-3 text-sm text-[#61736f]">
              {progress.chunks_completed} de {progress.chunks_total} blocos concluídos
            </p>
          )}
          {progress.error_message && (
            <div
              className={`mt-4 rounded-lg p-3 text-sm ${
                progress.status === "failed"
                  ? "bg-red-50 text-red-800"
                  : "bg-amber-50 text-amber-900"
              }`}
            >
              <p>{progress.error_message}</p>
              {progress.status === "failed" ? (
                <button className="mt-3 font-bold underline" onClick={() => void retry()}>
                  Repetir etapa com falha
                </button>
              ) : (
                <p className="mt-2 font-bold">Retomada automática — nenhuma ação necessária.</p>
              )}
            </div>
          )}
          <a
            className="mt-4 block text-sm font-bold text-[#176b58] underline"
            href={`/classes/${initialClass.id}/diagnostics`}
          >
            Abrir diagnóstico técnico
          </a>
        </aside>
      </section>
      <MaterialsPanel classId={initialClass.id} classTitle={initialClass.title} />
    </main>
  );
}
