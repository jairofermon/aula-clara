import type { Flashcard } from "./types";

function escapeCell(value: string): string {
  const normalized = value.replace(/\r?\n/g, "<br>");
  return `"${normalized.replaceAll('"', '""')}"`;
}

export function flashcardsToAnkiCsv(cards: Flashcard[]): string {
  const header = ["Frente", "Verso", "Tags", "Dificuldade", "Timestamp_ms"];
  const rows = cards.map((card) => [
    card.front,
    card.back,
    card.tags.join(" "),
    card.difficulty,
    String(card.timestamp_ms)
  ]);
  return [header, ...rows].map((row) => row.map(escapeCell).join(";")).join("\r\n");
}
