"use client";

import { useState } from "react";
import {
  flashcardsContentSchema,
  formatTimestamp,
  mindmapContentSchema,
  notesContentSchema,
  questionsContentSchema,
  summaryContentSchema
} from "@aula-clara/shared";
import { MindmapView } from "@/components/mindmap-view";

function StudyList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <section>
      <h4 className="text-base font-black text-[#173d35]">{title}</h4>
      <ul className="mt-2 space-y-2">
        {items.map((item, index) => (
          <li className="rounded-lg bg-slate-50 px-3 py-2 leading-6" key={`${title}-${index}`}>
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SummaryContent({ content }: { content: Record<string, unknown> }) {
  const parsed = summaryContentSchema.safeParse(content);
  if (!parsed.success) return null;
  const summary = parsed.data;
  return (
    <div className="mt-5 space-y-6 text-sm">
      <section className="rounded-xl bg-[#edf5f1] p-4">
        <h4 className="font-black text-[#173d35]">Visão geral</h4>
        <p className="mt-2 leading-7">{summary.overview}</p>
      </section>
      <StudyList title="Conceitos e definições" items={summary.concepts} />
      <StudyList title="Mecanismos" items={summary.mechanisms} />
      <StudyList title="Classificações" items={summary.classifications} />
      <StudyList title="Causas e consequências" items={summary.cause_and_effect} />
      <StudyList title="Exemplos e comentários do professor" items={summary.teacher_examples} />
      <StudyList title="Pontos enfatizados" items={summary.emphasized_points} />
      <StudyList title="Pegadinhas e cuidados" items={summary.traps} />
      <StudyList title="Prioridades para a prova" items={summary.exam_items} />
      {summary.references.length > 0 && (
        <section>
          <h4 className="text-base font-black text-[#173d35]">Referências no áudio</h4>
          <div className="mt-2 flex flex-wrap gap-2">
            {summary.references.map((reference, index) => (
              <span className="badge bg-[#edf5f1] text-[#176b58]" key={index}>
                {formatTimestamp(reference.timestamp_ms)}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function NotesContent({ content }: { content: Record<string, unknown> }) {
  const parsed = notesContentSchema.safeParse(content);
  if (!parsed.success) return null;
  const notes = parsed.data;
  return (
    <div className="mt-5 space-y-6 text-sm">
      <section className="rounded-xl bg-[#edf5f1] p-4">
        <h4 className="font-black text-[#173d35]">Índice cronológico</h4>
        <ol className="mt-2 list-inside list-decimal space-y-1 leading-6">
          {notes.chronological_index.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ol>
      </section>
      {notes.sections.map((section, index) => (
        <section className="border-l-4 border-[#176b58] pl-4" key={`${section.title}-${index}`}>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-base font-black text-[#173d35]">{section.title}</h4>
            <span className="badge bg-slate-100 text-[#176b58]">
              {formatTimestamp(section.timestamp_ms)}
            </span>
          </div>
          <p className="mt-2 whitespace-pre-wrap leading-7">{section.body}</p>
        </section>
      ))}
      <StudyList title="Exemplos do professor" items={notes.teacher_examples} />
      <StudyList title="Pontos enfatizados" items={notes.emphasized_points} />
      <StudyList title="Dúvidas remanescentes" items={notes.remaining_questions} />
    </div>
  );
}

function FlashcardsContent({ content }: { content: Record<string, unknown> }) {
  const parsed = flashcardsContentSchema.safeParse(content);
  if (!parsed.success) return null;
  const difficulty = { easy: "Fácil", medium: "Médio", hard: "Difícil" } as const;
  return (
    <div className="mt-5 grid gap-4 md:grid-cols-2">
      {parsed.data.flashcards.map((card) => (
        <details className="group rounded-xl border border-[#dbe4df] bg-white p-4" key={card.id}>
          <summary className="cursor-pointer list-none">
            <div className="flex items-start justify-between gap-3">
              <h4 className="font-black leading-6 text-[#173d35]">{card.front}</h4>
              <span className="badge shrink-0 bg-slate-100 text-slate-700">
                {difficulty[card.difficulty]}
              </span>
            </div>
            <p className="mt-3 text-xs font-bold text-[#176b58] group-open:hidden">
              Mostrar resposta
            </p>
          </summary>
          <div className="mt-4 border-t pt-4">
            <p className="leading-7">{card.back}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[#61736f]">
              <span>{formatTimestamp(card.timestamp_ms)}</span>
              {card.tags.map((tag) => (
                <span className="rounded-full bg-[#edf5f1] px-2 py-1" key={tag}>
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}

function QuestionCard({
  question
}: {
  question: ReturnType<typeof questionsContentSchema.parse>["questions"][number];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const answered = selected !== null;
  const correct = selected === question.correct_alternative_id;
  const difficulty = { easy: "Fácil", medium: "Médio", hard: "Difícil" } as const;
  return (
    <article className="rounded-xl border border-[#dbe4df] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h4 className="max-w-3xl font-black leading-6 text-[#173d35]">{question.question}</h4>
        <div className="flex gap-2 text-xs">
          <span className="badge bg-slate-100 text-slate-700">
            {difficulty[question.difficulty]}
          </span>
          <span className="badge bg-[#edf5f1] text-[#176b58]">
            {formatTimestamp(question.timestamp_ms)}
          </span>
        </div>
      </div>
      <fieldset className="mt-4 space-y-2">
        <legend className="sr-only">Escolha uma alternativa</legend>
        {question.alternatives.map((alternative, index) => {
          const isCorrect = alternative.id === question.correct_alternative_id;
          const isSelected = alternative.id === selected;
          const tone = answered
            ? isCorrect
              ? "border-emerald-500 bg-emerald-50 text-emerald-900"
              : isSelected
                ? "border-red-400 bg-red-50 text-red-900"
                : "border-slate-200 bg-slate-50 text-slate-600"
            : "border-slate-200 hover:border-[#176b58]";
          return (
            <label
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${tone}`}
              key={alternative.id}
            >
              <input
                className="mt-1 accent-[#176b58]"
                type="radio"
                name={`question-${question.id}`}
                value={alternative.id}
                checked={isSelected}
                onChange={() => setSelected(alternative.id)}
              />
              <span>
                <strong>{String.fromCharCode(65 + index)}.</strong> {alternative.text}
                {answered && isCorrect && <strong className="ml-2">Correta</strong>}
              </span>
            </label>
          );
        })}
      </fieldset>
      {answered && (
        <div
          className={`mt-4 rounded-lg p-4 text-sm ${correct ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-950"}`}
          role="status"
        >
          <p className="font-black">{correct ? "Resposta correta" : "Resposta incorreta"}</p>
          {!correct && selected && question.incorrect_explanations[selected] && (
            <p className="mt-2 leading-6">{question.incorrect_explanations[selected]}</p>
          )}
          <p className="mt-2 leading-6">
            <strong>Justificativa da correta:</strong> {question.correct_explanation}
          </p>
        </div>
      )}
    </article>
  );
}

function QuestionsContent({ content }: { content: Record<string, unknown> }) {
  const parsed = questionsContentSchema.safeParse(content);
  if (!parsed.success) return null;
  return (
    <div className="mt-5 space-y-4">
      {parsed.data.questions.map((question) => (
        <QuestionCard question={question} key={question.id} />
      ))}
    </div>
  );
}

function MindmapContent({ content }: { content: Record<string, unknown> }) {
  const parsed = mindmapContentSchema.safeParse(content);
  if (!parsed.success) return null;
  return (
    <div className="mt-5">
      <MindmapView root={parsed.data.root} />
    </div>
  );
}

export function MaterialContent({
  type,
  content
}: {
  type: string;
  content: Record<string, unknown>;
}) {
  const view =
    type === "summary" ? (
      <SummaryContent content={content} />
    ) : type === "notes" ? (
      <NotesContent content={content} />
    ) : type === "flashcards" ? (
      <FlashcardsContent content={content} />
    ) : type === "questions" ? (
      <QuestionsContent content={content} />
    ) : type === "mindmap" ? (
      <MindmapContent content={content} />
    ) : null;
  return (
    view ?? (
      <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
        Este material precisa ser gerado novamente para usar a visualização atual.
      </p>
    )
  );
}

function mindmapLines(
  node: ReturnType<typeof mindmapContentSchema.parse>["root"],
  depth = 0
): string[] {
  return [
    `${"  ".repeat(depth)}- ${node.label}`,
    ...node.children.flatMap((child) => mindmapLines(child, depth + 1))
  ];
}

export function materialToText(type: string, content: Record<string, unknown>): string {
  if (type === "summary") {
    const value = summaryContentSchema.parse(content);
    const sections: Array<[string, string[]]> = [
      ["Conceitos e definições", value.concepts],
      ["Mecanismos", value.mechanisms],
      ["Classificações", value.classifications],
      ["Causas e consequências", value.cause_and_effect],
      ["Exemplos e comentários do professor", value.teacher_examples],
      ["Pontos enfatizados", value.emphasized_points],
      ["Pegadinhas e cuidados", value.traps],
      ["Prioridades para a prova", value.exam_items]
    ];
    return [
      "VISÃO GERAL",
      value.overview,
      ...sections.flatMap(([title, items]) => [
        "",
        title.toUpperCase(),
        ...items.map((item) => `- ${item}`)
      ]),
      "",
      "REFERÊNCIAS NO ÁUDIO",
      ...value.references.map((reference) => `- ${formatTimestamp(reference.timestamp_ms)}`)
    ].join("\n");
  }
  if (type === "notes") {
    const value = notesContentSchema.parse(content);
    return [
      value.title.toUpperCase(),
      "",
      "ÍNDICE CRONOLÓGICO",
      ...value.chronological_index.map((item, index) => `${index + 1}. ${item}`),
      ...value.sections.flatMap((section) => [
        "",
        `${section.title.toUpperCase()} [${formatTimestamp(section.timestamp_ms)}]`,
        section.body
      ]),
      "",
      "EXEMPLOS DO PROFESSOR",
      ...value.teacher_examples.map((item) => `- ${item}`),
      "",
      "PONTOS ENFATIZADOS",
      ...value.emphasized_points.map((item) => `- ${item}`),
      "",
      "DÚVIDAS REMANESCENTES",
      ...value.remaining_questions.map((item) => `- ${item}`)
    ].join("\n");
  }
  if (type === "flashcards") {
    const value = flashcardsContentSchema.parse(content);
    return value.flashcards
      .flatMap((card, index) => [
        `FLASHCARD ${index + 1} [${formatTimestamp(card.timestamp_ms)}]`,
        `Pergunta: ${card.front}`,
        `Resposta: ${card.back}`,
        `Tags: ${card.tags.join(", ")}`,
        ""
      ])
      .join("\n");
  }
  if (type === "questions") {
    const value = questionsContentSchema.parse(content);
    return value.questions
      .flatMap((question, index) => [
        `QUESTÃO ${index + 1} [${formatTimestamp(question.timestamp_ms)}]`,
        question.question,
        ...question.alternatives.map(
          (alternative, alternativeIndex) =>
            `${String.fromCharCode(65 + alternativeIndex)}. ${alternative.text}${alternative.id === question.correct_alternative_id ? " (CORRETA)" : ""}`
        ),
        `Justificativa: ${question.correct_explanation}`,
        ...Object.entries(question.incorrect_explanations).map(
          ([id, explanation]) => `Por que ${id} está incorreta: ${explanation}`
        ),
        ""
      ])
      .join("\n");
  }
  if (type === "mindmap") {
    const value = mindmapContentSchema.parse(content);
    return [value.title.toUpperCase(), "", ...mindmapLines(value.root)].join("\n");
  }
  throw new Error("Material sem formato de exportação.");
}
