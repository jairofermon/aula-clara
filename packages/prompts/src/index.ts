export const PROMPT_VERSIONS = {
  review: "review-v1",
  notes: "notes-v1",
  summary: "summary-v1",
  flashcards: "flashcards-v1",
  questions: "questions-v1",
  mindmap: "mindmap-v1"
} as const;

export const REVIEW_RULES = `Faça revisão conservadora. Preserve sentido, exemplos, ordem e IDs. Não resuma nem introduza conhecimento externo. Corrija apenas pontuação, português evidente e termos técnicos com confiança. Marque números, nomes, dosagens e trechos sem sentido como issues.`;
