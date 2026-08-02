export const CLASS_STATUSES = [
  "uploaded",
  "queued",
  "preparing_audio",
  "transcribing",
  "reviewing",
  "needs_user_review",
  "generating_materials",
  "completed",
  "failed"
] as const;

export type ClassStatus = (typeof CLASS_STATUSES)[number];

export const REVIEW_STATUSES = [
  "unreviewed",
  "auto_reviewed",
  "needs_review",
  "user_confirmed",
  "user_edited"
] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const MATERIAL_TYPES = [
  "notes",
  "summary",
  "flashcards",
  "questions",
  "mindmap",
  "pdf"
] as const;
export type MaterialType = (typeof MATERIAL_TYPES)[number];

export interface TranscriptSegment {
  id: string;
  sequence_number: number;
  start_ms: number;
  end_ms: number;
  speaker_label: string | null;
  raw_text: string;
  revised_text: string | null;
  confidence: number | null;
  review_status: ReviewStatus;
  user_confirmed: boolean;
  issues?: TranscriptIssue[];
}

export interface TranscriptIssue {
  id: string;
  transcript_segment_id: string;
  issue_type: string;
  description: string;
  proposed_text: string | null;
  confidence: number | null;
  status: "open" | "resolved" | "dismissed";
}

export interface Flashcard {
  id: string;
  front: string;
  back: string;
  timestamp_ms: number;
  tags: string[];
  difficulty: "easy" | "medium" | "hard";
  source_segment_ids: string[];
}
