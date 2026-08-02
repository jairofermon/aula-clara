import { z } from "zod";
import { CLASS_STATUSES, MATERIAL_TYPES, REVIEW_STATUSES } from "./types";

export const uuidSchema = z.uuid();
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, "SHA-256 inválido");

export const subjectSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional().default("")
});

export const classSchema = z.object({
  subject_id: uuidSchema,
  title: z.string().trim().min(2).max(180),
  topic: z.string().trim().max(300).optional().default(""),
  teacher_name: z.string().trim().max(120).optional().or(z.literal("")),
  class_date: z.iso.date(),
  language: z.string().trim().min(2).max(12).default("pt"),
  speaker_count: z.coerce.number().int().min(1).max(20).optional(),
  notes: z.string().trim().max(5000).optional().default("")
});

export const allowedAudioMimeTypes = [
  "audio/m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-m4a",
  "audio/x-wav",
  "video/mp4",
  "video/webm",
  "audio/webm"
] as const;

export const uploadStartSchema = z.object({
  class_id: uuidSchema,
  original_name: z.string().trim().min(1).max(255),
  mime_type: z.string().trim().min(1).max(120),
  size_bytes: z.number().int().positive(),
  duration_ms: z.number().int().positive().optional(),
  sha256: sha256Schema,
  file_type: z.enum(["audio", "slides", "supplement"])
});

export const segmentUpdateSchema = z
  .object({
    revised_text: z.string().trim().min(1).max(20000).optional(),
    action: z.enum(["save", "confirm", "keep_original", "accept_suggestion"])
  })
  .strict();

export const materialRequestSchema = z.object({ material_type: z.enum(MATERIAL_TYPES) });

export const progressSchema = z.object({
  status: z.enum(CLASS_STATUSES),
  progress: z.number().int().min(0).max(100),
  current_stage: z.string().nullable(),
  error_message: z.string().nullable(),
  chunks_completed: z.number().int().nonnegative(),
  chunks_total: z.number().int().nonnegative()
});

export const transcriptSegmentSchema = z.object({
  id: uuidSchema,
  sequence_number: z.number().int().nonnegative(),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().positive(),
  speaker_label: z.string().nullable(),
  raw_text: z.string(),
  revised_text: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  review_status: z.enum(REVIEW_STATUSES),
  user_confirmed: z.boolean()
});

export const flashcardSchema = z.object({
  id: z.string().min(1),
  front: z.string().min(1),
  back: z.string().min(1),
  timestamp_ms: z.number().int().nonnegative(),
  tags: z.array(z.string()),
  difficulty: z.enum(["easy", "medium", "hard"]),
  source_segment_ids: z.array(uuidSchema).min(1)
});

export const questionSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    alternatives: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })).length(5),
    correct_alternative_id: z.string().min(1),
    correct_explanation: z.string().min(1),
    incorrect_explanations: z.record(z.string(), z.string()),
    difficulty: z.enum(["easy", "medium", "hard"]),
    timestamp_ms: z.number().int().nonnegative(),
    source_segment_ids: z.array(uuidSchema).min(1)
  })
  .superRefine((question, context) => {
    const matching = question.alternatives.filter(
      (item) => item.id === question.correct_alternative_id
    );
    if (matching.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "A alternativa correta deve existir exatamente uma vez"
      });
    }
    const alternativeIds = new Set(question.alternatives.map((item) => item.id));
    const expectedIncorrect = new Set(
      [...alternativeIds].filter((id) => id !== question.correct_alternative_id)
    );
    const explainedIncorrect = new Set(Object.keys(question.incorrect_explanations));
    if (
      expectedIncorrect.size !== explainedIncorrect.size ||
      [...expectedIncorrect].some((id) => !explainedIncorrect.has(id))
    ) {
      context.addIssue({
        code: "custom",
        message: "Todas e somente as alternativas incorretas precisam de explicação"
      });
    }
  });

export const reviewIssueSchema = z
  .object({
    type: z.enum([
      "unclear",
      "technical_term",
      "medical_term",
      "number",
      "dosage",
      "proper_name",
      "nonsense"
    ]),
    description: z.string().trim().min(1),
    proposed_text: z.string().trim().min(1).nullable().optional()
  })
  .strict();

export const reviewedSegmentSchema = z
  .object({
    segment_id: uuidSchema,
    revised_text: z.string().trim().min(1),
    needs_review: z.boolean(),
    confidence: z.number().min(0).max(1),
    issues: z.array(reviewIssueSchema)
  })
  .strict()
  .superRefine((segment, context) => {
    if (segment.needs_review !== segment.issues.length > 0) {
      context.addIssue({
        code: "custom",
        message: "needs_review deve corresponder à existência de issues"
      });
    }
  });

export const reviewBatchSchema = z
  .object({ segments: z.array(reviewedSegmentSchema).min(1) })
  .strict();

export const timestampReferenceSchema = z
  .object({
    timestamp_ms: z.number().int().nonnegative(),
    source_segment_ids: z.array(uuidSchema).min(1)
  })
  .strict();

export const summaryContentSchema = z
  .object({
    overview: z.string().trim().min(1),
    concepts: z.array(z.string().trim().min(1)),
    mechanisms: z.array(z.string().trim().min(1)),
    classifications: z.array(z.string().trim().min(1)),
    cause_and_effect: z.array(z.string().trim().min(1)),
    teacher_examples: z.array(z.string().trim().min(1)),
    emphasized_points: z.array(z.string().trim().min(1)),
    traps: z.array(z.string().trim().min(1)),
    exam_items: z.array(z.string().trim().min(1)),
    references: z.array(timestampReferenceSchema)
  })
  .strict();

export const flashcardsContentSchema = z
  .object({ flashcards: z.array(flashcardSchema).min(1) })
  .strict();

export const questionsContentSchema = z
  .object({ questions: z.array(questionSchema).min(1) })
  .strict();

export interface MindmapNodeContent {
  id: string;
  label: string;
  children: MindmapNodeContent[];
}

export const mindmapNodeSchema: z.ZodType<MindmapNodeContent> = z.lazy(() =>
  z
    .object({
      id: z.string().trim().min(1),
      label: z.string().trim().min(1),
      children: z.array(mindmapNodeSchema).default([])
    })
    .strict()
);

export const mindmapContentSchema = z
  .object({
    title: z.string().trim().min(1),
    root: mindmapNodeSchema,
    mermaid: z
      .string()
      .trim()
      .max(20_000)
      .startsWith("mindmap")
      .refine((value) => !/[<>]/u.test(value) && !/\b(?:click|javascript:)\b/iu.test(value), {
        message: "Mermaid contém construção não permitida"
      })
  })
  .strict();

export const notesSectionSchema = z
  .object({
    title: z.string().trim().min(1),
    body: z.string().trim().min(1),
    timestamp_ms: z.number().int().nonnegative(),
    source_segment_ids: z.array(uuidSchema).min(1)
  })
  .strict();

export const notesContentSchema = z
  .object({
    title: z.string().trim().min(1),
    chronological_index: z.array(z.string().trim().min(1)),
    sections: z.array(notesSectionSchema).min(1),
    teacher_examples: z.array(z.string().trim().min(1)),
    emphasized_points: z.array(z.string().trim().min(1)),
    remaining_questions: z.array(z.string().trim().min(1))
  })
  .strict();
