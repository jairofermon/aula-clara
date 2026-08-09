import { formatTimestamp } from "@aula-clara/shared";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export interface TranscriptPdfInput {
  classTitle: string;
  subjectName: string;
  classDate: string;
  transcriptVersion: number;
  transcript: Array<{
    start_ms: number;
    end_ms: number;
    speaker_label: string | null;
    text: string;
  }>;
}

export interface StudyMaterialPdfInput {
  title: string;
  classTitle: string;
  text: string;
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

export async function buildTranscriptPdf(input: TranscriptPdfInput): Promise<Uint8Array> {
  if (!input.transcript.length) throw new Error("A transcrição está vazia.");
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

  let page: PDFPage = cover;
  let y = 0;
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
  newContentPage();
  heading("Transcrição completa e corrigida", 21);
  paragraph("Os horários abaixo permitem localizar cada trecho diretamente no áudio original.", 10);

  for (const segment of input.transcript) {
    ensureSpace(42);
    const interval = `${formatTimestamp(segment.start_ms)} – ${formatTimestamp(segment.end_ms)}`;
    const speaker = segment.speaker_label ? ` · ${segment.speaker_label}` : "";
    page.drawText(safePdfText(`${interval}${speaker}`), {
      x: MARGIN,
      y,
      size: 9.5,
      font: bold,
      color: green
    });
    y -= 17;
    paragraph(segment.text);
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

  document.setTitle(safePdfText(`${input.classTitle} - Transcrição corrigida`));
  document.setSubject(safePdfText(input.subjectName));
  document.setProducer("Aula Clara - pdf-lib");
  return document.save();
}

export async function buildStudyMaterialPdf(input: StudyMaterialPdfInput): Promise<Uint8Array> {
  if (!input.text.trim()) throw new Error("O material está vazio.");
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const green = rgb(0.09, 0.42, 0.35);
  const ink = rgb(0.11, 0.16, 0.15);
  const muted = rgb(0.38, 0.45, 0.44);
  let page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const addPage = () => {
    page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  };
  const ensureSpace = (height: number) => {
    if (y - height < 60) addPage();
  };
  const drawWrapped = (text: string, font: PDFFont, size: number, color = ink) => {
    const lines = wrapText(text, font, size, CONTENT_WIDTH);
    for (const line of lines) {
      ensureSpace(size + 6);
      if (line) page.drawText(line, { x: MARGIN, y, size, font, color });
      y -= size + 6;
    }
  };

  drawWrapped(input.title, bold, 24, green);
  y -= 4;
  drawWrapped(input.classTitle, regular, 10, muted);
  y -= 16;
  for (const rawLine of input.text.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (!line) {
      y -= 8;
      continue;
    }
    const heading =
      line.length < 90 &&
      (line === line.toLocaleUpperCase("pt-BR") || /^(?:FLASHCARD|QUESTÃO)\s+\d+/u.test(line));
    if (heading) {
      y -= 5;
      drawWrapped(line, bold, 13, green);
      y -= 3;
    } else {
      drawWrapped(line, regular, 10.5);
      y -= 3;
    }
  }

  const pages = document.getPages();
  pages.forEach((currentPage, index) => {
    currentPage.drawText(
      safePdfText(`Aula Clara · ${input.title} · página ${index + 1}/${pages.length}`),
      { x: MARGIN, y: 28, size: 8, font: regular, color: muted }
    );
  });
  document.setTitle(safePdfText(`${input.title} - ${input.classTitle}`));
  document.setProducer("Aula Clara - pdf-lib");
  return document.save();
}
