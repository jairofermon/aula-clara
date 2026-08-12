"use client";

import { useState } from "react";
import { Copy, Download, ExternalLink } from "lucide-react";
import type { TranscriptSegment } from "@aula-clara/shared";

export const CHATGPT_STUDY_PROMPT = `Serão anexados dois arquivos: o PDF da transcrição da aula e provavelmente e não obrigatoriamente o PDF dos slides usados pelo professor.

Organize o texto do PDF da transcrição em leitura contínua, mantendo os timestamps ao lado direito da folha, sem atrapalhar o texto, junto aos respectivos trechos. Use o provável PDF dos slides como apoio para compreender o contexto, corrigir termos técnicos e estruturar os assuntos. Depois, usando exclusivamente o conteúdo da aula, dos slides e de inteligência artificial para melhorar o conteúdo e corrigir possíveis erros, produza:

Mapa mental hierárquico com os conceitos e relações mais importantes.

Resumo explicativo para revisão rápida, destacando conceitos, mecanismos, classificações, exemplos do professor, pegadinhas e pontos importantes para prova.

Apostila completa, organizada por assuntos, clara, aprofundada e fiel à aula.

Flashcards: no mínimo 10, mas quantos forem necessários para abordar todos os temas que podem cair em prova, sem repetir desnecessariamente as questões.

Questões de múltipla escolha: no mínimo 10, mas quantas forem necessárias para abordar todos os temas que podem cair em prova; cinco alternativas, de A até E; alto nível de elaboração; apenas uma correta; gabarito comentado ao final, justificando a correta e explicando por que as demais estão erradas.

Não invente informações, melhore e eleve a qualidade do material com inteligência artificial. Quando um trecho da transcrição estiver duvidoso, use o contexto da aula, dos slides anexados se houver e inteligência artificial em último caso; se a dúvida permanecer, use inteligência artificial para analisar o material como um todo e corrigir o texto, eliminando as dúvidas e deixando o material contínuo, correto e confiável para um excelente estudo, deixando o conteúdo o mais didático possível.`;

function fileSlug(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 80);
}

export function TranscriptHandoffPanel({
  classTitle,
  subjectName,
  classDate,
  transcriptVersion,
  segments
}: {
  classTitle: string;
  subjectName: string;
  classDate: string;
  transcriptVersion: number;
  segments: TranscriptSegment[];
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function downloadPdf() {
    if (!segments.length) return;
    setBusy(true);
    setMessage("Montando o PDF…");
    try {
      const { buildTranscriptPdf } = await import("@/lib/client-pdf");
      const transcript = segments
        .map((segment) => ({
          start_ms: segment.start_ms,
          end_ms: segment.end_ms,
          speaker_label: segment.speaker_label,
          text: segment.revised_text ?? segment.raw_text
        }))
        .filter((segment) => segment.text.trim().length > 0);
      const bytes = await buildTranscriptPdf({
        classTitle,
        subjectName,
        classDate,
        transcriptVersion,
        transcript
      });
      const blob = new Blob([Uint8Array.from(bytes)], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `aula-clara-${fileSlug(classTitle) || "transcricao"}.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage("PDF baixado. Agora anexe-o ao ChatGPT com o prompt abaixo.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível montar o PDF.");
    } finally {
      setBusy(false);
    }
  }

  async function copyPrompt() {
    await navigator.clipboard.writeText(CHATGPT_STUDY_PROMPT);
    setMessage("Prompt copiado. Anexe o PDF no ChatGPT e cole a instrução.");
  }

  return (
    <section className="card mt-8 border-2 border-[#b9d8cd] p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-black uppercase tracking-wide text-[#176b58]">Fluxo simples</p>
          <h2 className="mt-1 text-2xl font-black">Baixar a transcrição e estudar no ChatGPT</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#61736f]">
            O PDF é criado neste navegador, sem fila e sem usar outra cota de IA. Depois, anexe-o ao
            ChatGPT e use o prompt pronto.
          </p>
        </div>
        <span className="badge bg-emerald-50 text-emerald-800">Sem custo de API</span>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <div className="rounded-xl bg-[#edf5f1] p-4">
          <strong className="block text-base">1. Transcrição em PDF</strong>
          <p className="mt-1 text-sm leading-6 text-[#526963]">
            Capa, texto integral, intervalos de áudio e paginação no formato Aula Clara.
          </p>
          <button
            className="btn btn-primary mt-3"
            disabled={!segments.length || busy}
            onClick={() => void downloadPdf()}
          >
            <Download size={17} aria-hidden /> {busy ? "Gerando PDF…" : "Baixar transcrição em PDF"}
          </button>
        </div>

        <div className="rounded-xl bg-[#edf5f1] p-4">
          <strong className="block text-base">2. Gerar o material de estudo no ChatGPT</strong>
          <p className="mt-1 text-sm leading-6 text-[#526963]">
            O prompt solicita leitura contínua, questões avançadas, apostila, flashcards, mapa
            mental e resumo.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="btn btn-secondary" onClick={() => void copyPrompt()}>
              <Copy size={17} aria-hidden /> Copiar prompt
            </button>
            <a
              className="btn btn-secondary"
              href="https://chatgpt.com/"
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={17} aria-hidden /> Abrir ChatGPT
            </a>
          </div>
        </div>
      </div>

      <details className="mt-4 rounded-xl border border-[#dbe4df] bg-white p-4">
        <summary className="cursor-pointer font-bold text-[#176b58]">Ver o prompt completo</summary>
        <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-6 text-[#334a44]">
          {CHATGPT_STUDY_PROMPT}
        </pre>
      </details>

      {message && (
        <p className="mt-4 text-sm font-bold text-[#176b58]" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
