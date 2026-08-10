export const PROMPT_VERSIONS = {
  review: "review-v4",
  notes: "notes-v4",
  summary: "summary-v4",
  flashcards: "flashcards-v4",
  questions: "questions-v5",
  mindmap: "mindmap-v5"
} as const;

export const REVIEW_RULES = `Produza a transcrição final corrigida como texto contínuo, claro e natural, fiel ao conteúdo acadêmico do áudio. Preserve conceitos, explicações, exemplos, relações, ordem, timestamps e IDs. Remova vícios de linguagem, falsos começos, repetições acidentais, saudações, interrupções sem conteúdo e comentários meramente administrativos. Não resuma o conteúdo útil nem introduza conhecimento externo. Corrija pontuação, erros evidentes de português e termos técnicos quando o contexto sustentar a correção. Em caso de incerteza, mantenha a formulação mais fiel em vez de inventar.`;
