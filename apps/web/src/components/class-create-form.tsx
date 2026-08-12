"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createSHA256 } from "hash-wasm";
import { CircleStop, UploadCloud } from "lucide-react";
import { Upload } from "tus-js-client";
import { getPublicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";
import { supabaseTusEndpoint, TUS_CHUNK_SIZE_BYTES } from "@/lib/tus-upload";

interface Subject {
  id: string;
  name: string;
}
interface UploadState {
  name: string;
  percent: number;
  stage: string;
}

async function hashFile(file: File) {
  const hasher = await createSHA256();
  hasher.init();
  const chunkSize = 4 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    hasher.update(new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer()));
  }
  return hasher.digest("hex");
}

function mediaDurationMs(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const media = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
    const objectUrl = URL.createObjectURL(file);
    let settled = false;
    const timeout = window.setTimeout(
      () => finish(new Error("Tempo esgotado ao ler o áudio.")),
      15_000
    );
    function cleanup() {
      window.clearTimeout(timeout);
      media.onloadedmetadata = null;
      media.onerror = null;
      media.removeAttribute("src");
      media.load();
      URL.revokeObjectURL(objectUrl);
    }
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      if (error) {
        cleanup();
        reject(error);
        return;
      }
      const duration = media.duration;
      cleanup();
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error("Não foi possível identificar a duração do áudio."));
        return;
      }
      resolve(Math.round(duration * 1000));
    }
    media.preload = "metadata";
    media.onloadedmetadata = () => finish();
    media.onerror = () => finish(new Error("O navegador não conseguiu validar este áudio."));
    media.src = objectUrl;
  });
}

function putWithProgress(
  url: string,
  file: File,
  signalRef: React.MutableRefObject<XMLHttpRequest | null>,
  onProgress: (value: number) => void
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    signalRef.current = xhr;
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (event) =>
      event.lengthComputable && onProgress(Math.round((event.loaded / event.total) * 100));
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload_${xhr.status}`));
    xhr.onerror = () => reject(new Error("upload_network"));
    xhr.onabort = () => reject(new DOMException("Upload cancelado", "AbortError"));
    xhr.send(file);
  });
}

async function putTusWithProgress(
  file: File,
  storagePath: string,
  uploadRef: React.MutableRefObject<Upload | null>,
  onProgress: (value: number) => void
) {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Entre novamente antes de enviar o áudio.");
  const env = getPublicEnv();
  await new Promise<void>((resolve, reject) => {
    const upload = new Upload(file, {
      endpoint: supabaseTusEndpoint(env.NEXT_PUBLIC_SUPABASE_URL),
      retryDelays: [0, 1_000, 3_000, 5_000],
      headers: {
        authorization: `Bearer ${token}`,
        apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        "x-upsert": "false"
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: TUS_CHUNK_SIZE_BYTES,
      metadata: {
        bucketName: "class-audio",
        objectName: storagePath,
        contentType: file.type || "application/octet-stream",
        cacheControl: "3600"
      },
      onError: (error) => reject(error),
      onProgress: (uploaded, total) => onProgress(Math.round((uploaded / total) * 100)),
      onSuccess: () => resolve()
    });
    uploadRef.current = upload;
    void upload
      .findPreviousUploads()
      .then((previous) => {
        if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      })
      .catch(reject);
  });
}

export function ClassCreateForm({
  subjects,
  defaultSubject,
  maxAudioUploadBytes
}: {
  subjects: Subject[];
  defaultSubject?: string;
  maxAudioUploadBytes: number;
}) {
  const router = useRouter();
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const tusRef = useRef<Upload | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [upload, setUpload] = useState<UploadState | null>(null);

  async function sendFile(classId: string, file: File) {
    setUpload({ name: file.name, percent: 0, stage: "Validando duração e arquivo…" });
    const durationMs = await mediaDurationMs(file);
    setUpload({ name: file.name, percent: 0, stage: "Calculando hash com segurança…" });
    const sha256 = await hashFile(file);
    const start = await fetch("/api/uploads/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        class_id: classId,
        original_name: file.name,
        mime_type: file.type || "application/octet-stream",
        size_bytes: file.size,
        ...(durationMs ? { duration_ms: durationMs } : {}),
        sha256,
        file_type: "audio"
      })
    });
    const startPayload = (await start.json()) as {
      data?: {
        file_id: string;
        bucket: string;
        storage_path: string;
        upload_mode: "supabase_tus" | "supabase_signed";
        signed_url?: string;
      };
      error?: { message: string };
    };
    if (!start.ok || !startPayload.data)
      throw new Error(startPayload.error?.message ?? "Não foi possível iniciar o upload.");
    const updateProgress = (percent: number) =>
      setUpload({
        name: file.name,
        percent,
        stage:
          startPayload.data?.upload_mode === "supabase_tus"
            ? "Enviando em partes retomáveis ao armazenamento privado…"
            : "Enviando diretamente ao armazenamento privado…"
      });
    if (startPayload.data.upload_mode === "supabase_tus") {
      await putTusWithProgress(file, startPayload.data.storage_path, tusRef, updateProgress);
    } else {
      if (!startPayload.data.signed_url) throw new Error("O armazenamento não autorizou o envio.");
      await putWithProgress(startPayload.data.signed_url, file, xhrRef, updateProgress);
    }
    const complete = await fetch("/api/uploads/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: startPayload.data.file_id })
    });
    if (!complete.ok) {
      const payload = (await complete.json()) as { error?: { message: string } };
      throw new Error(payload.error?.message ?? "Não foi possível confirmar o upload.");
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    const audio = form.get("audio");
    if (!(audio instanceof File) || audio.size === 0) {
      setMessage("Selecione um arquivo de áudio.");
      setBusy(false);
      return;
    }
    if (audio.size > maxAudioUploadBytes) {
      setMessage(
        `Na edição gratuita, o áudio deve ter até ${Math.floor(maxAudioUploadBytes / 1024 / 1024)} MB.`
      );
      setBusy(false);
      return;
    }
    const speakerRaw = String(form.get("speaker_count") ?? "");
    const body = {
      subject_id: form.get("subject_id"),
      title: form.get("title"),
      topic: form.get("topic"),
      teacher_name: form.get("teacher_name"),
      class_date: form.get("class_date"),
      language: form.get("language"),
      ...(speakerRaw ? { speaker_count: Number(speakerRaw) } : {}),
      notes: form.get("notes")
    };
    try {
      const created = await fetch("/api/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const createdPayload = (await created.json()) as {
        data?: { id: string };
        error?: { message: string };
      };
      if (!created.ok || !createdPayload.data)
        throw new Error(createdPayload.error?.message ?? "Não foi possível criar a aula.");
      const classId = createdPayload.data.id;
      await sendFile(classId, audio);
      const processing = await fetch(`/api/classes/${classId}/process`, { method: "POST" });
      if (!processing.ok) {
        const payload = (await processing.json()) as { error?: { message: string } };
        throw new Error(
          payload.error?.message ?? "Upload concluído, mas o processamento não iniciou."
        );
      }
      router.push(`/classes/${classId}/transcript`);
    } catch (error) {
      setMessage(
        error instanceof DOMException && error.name === "AbortError"
          ? "Upload cancelado. Você pode criar uma nova tentativa."
          : error instanceof Error
            ? error.message
            : "Falha inesperada."
      );
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-6 lg:grid-cols-[1fr_360px]" onSubmit={(event) => void submit(event)}>
      <div className="card grid gap-5 p-6 sm:grid-cols-2">
        <label>
          <span className="label">Disciplina</span>
          <select className="field" name="subject_id" required defaultValue={defaultSubject ?? ""}>
            <option value="" disabled>
              Selecione
            </option>
            {subjects.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Data</span>
          <input
            className="field"
            type="date"
            name="class_date"
            required
            defaultValue={new Date().toISOString().slice(0, 10)}
          />
        </label>
        <label className="sm:col-span-2">
          <span className="label">Título</span>
          <input
            className="field"
            name="title"
            required
            minLength={2}
            maxLength={180}
            placeholder="Ex.: Introdução à fisiologia renal"
          />
        </label>
        <label className="sm:col-span-2">
          <span className="label">Assunto</span>
          <input className="field" name="topic" maxLength={300} />
        </label>
        <label>
          <span className="label">Professor (opcional)</span>
          <input className="field" name="teacher_name" maxLength={120} />
        </label>
        <label>
          <span className="label">Idioma</span>
          <select className="field" name="language" defaultValue="pt">
            <option value="pt">Português</option>
            <option value="en">Inglês</option>
            <option value="es">Espanhol</option>
          </select>
        </label>
        <label>
          <span className="label">Falantes aproximados</span>
          <input className="field" type="number" name="speaker_count" min={1} max={20} />
        </label>
        <label className="sm:col-span-2">
          <span className="label">Observações / glossário</span>
          <textarea
            className="field min-h-28"
            name="notes"
            maxLength={5000}
            placeholder="Termos próprios, siglas ou contexto útil"
          />
        </label>
      </div>
      <aside className="space-y-5">
        <div className="card space-y-4 p-6">
          <h2 className="text-xl font-black">Arquivos</h2>
          <label>
            <span className="label">Áudio obrigatório</span>
            <input
              className="field"
              type="file"
              name="audio"
              required
              accept=".m4a,.mp3,.wav,.mp4,.webm,audio/*,video/mp4,video/webm"
            />
            <span className="mt-2 block text-xs text-[#61736f]">
              Limite gratuito: {Math.floor(maxAudioUploadBytes / 1024 / 1024)} MB. Envios grandes
              são retomados automaticamente se a conexão oscilar.
            </span>
          </label>
          {upload && (
            <div className="rounded-xl bg-[#edf5f1] p-4" role="status">
              <p className="truncate text-sm font-bold">{upload.name}</p>
              <p className="mt-1 text-xs text-[#61736f]">{upload.stage}</p>
              <div className="mt-3 h-2 rounded-full bg-white">
                <div
                  className="h-full rounded-full bg-[#176b58]"
                  style={{ width: `${upload.percent}%` }}
                />
              </div>
              <p className="mt-1 text-right text-xs">{upload.percent}%</p>
            </div>
          )}
          <div className="rounded-xl border-l-4 border-[#e6b85c] bg-[#fff9ec] p-4 text-xs leading-5">
            Confirme que você possui autorização para gravar e processar esta aula.
          </div>
          <button className="btn btn-primary w-full" disabled={busy}>
            <UploadCloud size={18} aria-hidden />
            {busy ? "Processando envio…" : "Criar e iniciar"}
          </button>
          {busy && upload && (
            <button
              type="button"
              className="btn btn-secondary w-full"
              onClick={() => {
                xhrRef.current?.abort();
                void tusRef.current?.abort(true);
              }}
            >
              <CircleStop size={18} aria-hidden /> Cancelar upload
            </button>
          )}
          {message && (
            <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">
              {message}
            </p>
          )}
        </div>
      </aside>
    </form>
  );
}
