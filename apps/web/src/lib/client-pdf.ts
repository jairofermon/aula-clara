import { formatTimestamp, notesContentSchema } from "@aula-clara/shared";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export interface NotesPdfInput {
  classTitle: string;
  subjectName: string;
  classDate: string;
  transcriptVersion: number;
  notes: unknown;
}

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 52;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

function safePdfText(value: string): string {
  const normalized = value
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201C\u201D]/gu, '"')
    .replace(/[\u2013\u2014]/gu, "-");

  return Array.from(normalized, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const isPrintableLatin =
      (codePoint >= 32 && codePoint <= 126) || (codePoint >= 160 && codePoint <= 255);
    return codePoint === 10 || isPrintableLatin ? character : "?";
  }).join("");
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of safePdfText(text).split(/\r?\n/u)) {
    const words = paragraph.split(/\s+/u).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        current = word;
        continue;
      }
      let piece = "";
      for (const character of word) {
        if (font.widthOfTextAtSize(piece + character, size) > maxWidth) {
          if (piece) lines.push(piece);
          piece = character;
        } else {
          piece += character;
        }
      }
      current = piece;
    }
    if (current) lines.push(current);
  }
  return lines;
}

export async function buildNotesPdf(input: NotesPdfInput): Promise<Uint8Array> {
  const notes = notesContentSchema.parse(input.notes);
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const green = rgb(0.09, 0.42, 0.35);
  const ink = rgb(0.11, 0.16, 0.15);
  const muted = rgb(0.38, 0.45, 0.44);

  const cover = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  cover.drawRectangle({ x: 0, y: PAGE_HEIGHT - 190, width: PAGE_WIDTH, height: 190, color: green });
  cover.drawText("AULA CLARA", {
    x: MARGIN,
    y: PAGE_HEIGHT - 84,
    size: 15,
    font: bold,
    color: rgb(1, 1, 1)
  });
  let coverY = PAGE_HEIGHT - 250;
  for (const line of wrapText(input.classTitle, bold, 28, CONTENT_WIDTH)) {
    cover.drawText(line, { x: MARGIN, y: coverY, size: 28, font: bold, color: ink });
    coverY -= 36;
  }
  coverY -= 16;
  cover.drawText(safePdfText(input.subjectName), {
    x: MARGIN,
    y: coverY,
    size: 16,
    font: regular,
    color: green
  });
  cover.drawText(`Data: ${safePdfText(input.classDate)}`, {
    x: MARGIN,
    y: coverY - 30,
    size: 11,
    font: regular,
    color: muted
  });
  cover.drawText(`Versão da transcrição: ${input.transcriptVersion}`, {
    x: MARGIN,
    y: coverY - 50,
    size: 11,
    font: regular,
    color: muted
  });

  let page: PDFPage;
  let y: number;
  function newContentPage() {
    page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - 72;
  }
  function ensureSpace(height: number) {
    if (y - height < 65) newContentPage();
  }
  function heading(text: string, size = 18) {
    const lines = wrapText(text, bold, size, CONTENT_WIDTH);
    ensureSpace(lines.length * (size + 6) + 14);
    for (const line of lines) {
      page.drawText(line, { x: MARGIN, y, size, font: bold, color: green });
      y -= size + 6;
    }
    y -= 8;
  }
  function paragraph(text: string, size = 10.5, indent = 0) {
    const lines = wrapText(text, regular, size, CONTENT_WIDTH - indent);
    for (const line of lines) {
      ensureSpace(size + 5);
      if (line) page.drawText(line, { x: MARGIN + indent, y, size, font: regular, color: ink });
      y -= size + 5;
    }
    y -= 5;
  }
  function bullets(items: string[]) {
    for (const item of items) paragraph(`- ${item}`, 10.5, 8);
  }

  newContentPage();
  heading("Índice cronológico", 21);
  bullets(notes.chronological_index);

  for (const section of notes.sections) {
    heading(section.title, 17);
    paragraph(`Timestamp: ${formatTimestamp(section.timestamp_ms)}`, 9.5);
    paragraph(section.body);
  }
  if (notes.teacher_examples.length) {
    heading("Exemplos do professor", 17);
    bullets(notes.teacher_examples);
  }
  if (notes.emphasized_points.length) {
    heading("Pontos enfatizados", 17);
    bullets(notes.emphasized_points);
  }
  if (notes.remaining_questions.length) {
    heading("Dúvidas remanescentes", 17);
    bullets(notes.remaining_questions);
  }

  const pages = document.getPages();
  pages.forEach((currentPage, index) => {
    if (index > 0) {
      currentPage.drawText(safePdfText(input.classTitle).slice(0, 72), {
        x: MARGIN,
        y: PAGE_HEIGHT - 34,
        size: 8.5,
        font: regular,
        color: muted
      });
    }
    currentPage.drawText(
      `Aula Clara - transcrição v${input.transcriptVersion} - página ${index + 1}/${pages.length}`,
      { x: MARGIN, y: 30, size: 8, font: regular, color: muted }
    );
  });

  document.setTitle(safePdfText(notes.title));
  document.setSubject(safePdfText(input.subjectName));
  document.setProducer("Aula Clara - pdf-lib");
  return document.save();
}
