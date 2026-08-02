import { writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

function writeSineWave(path: string, durationSeconds = 4, sampleRate = 16_000) {
  const sampleCount = durationSeconds * sampleRate;
  const dataSize = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    wav.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 520 * index) / sampleRate) * 8_000),
      44 + index * 2
    );
  }
  writeFileSync(path, wav);
}

test("fluxo vertical: upload, transcrição, revisão e resumo", async ({ page }, testInfo) => {
  test.skip(process.env.RUN_E2E !== "1", "E2E requer Supabase, web, FFmpeg e worker fake locais");
  const audioPath = testInfo.outputPath("aula-teste.wav");
  writeSineWave(audioPath);
  const email = `e2e-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("Como devemos chamar você?").fill("Teste E2E");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill("Teste-seguro-123");
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(page).toHaveURL(/dashboard/);

  await page.goto("/subjects");
  await page.getByLabel("Nome").fill("Biologia E2E");
  await page.getByLabel("Descrição").fill("Disciplina criada pelo teste");
  await page.getByRole("button", { name: "Criar disciplina" }).click();
  await expect(page.getByText("Biologia E2E")).toBeVisible();

  await page.goto("/classes/new");
  await page.getByLabel("Disciplina").selectOption({ label: "Biologia E2E" });
  await page.getByLabel("Título").fill("Aula de teste controlada");
  await page.getByLabel("Assunto").fill("Fluxo completo");
  await page.getByLabel("Falantes aproximados").fill("1");
  await page.getByLabel("Áudio obrigatório").setInputFiles(audioPath);
  await page.getByRole("button", { name: "Criar e iniciar" }).click();
  await expect(page).toHaveURL(/\/classes\/.+\/transcript/, { timeout: 60_000 });

  await expect(page.getByText("Texto bruto (preservado)").first()).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: /Ir para 00:00/ }).click();
  const revised = page.getByLabel("Texto revisado").last();
  await revised.fill("O professor destacou um trecho conferido pelo teste.");
  await page.getByRole("button", { name: "Confirmar" }).last().click();
  await expect(page.getByText("Confirmado").last()).toBeVisible();

  await page.getByRole("button", { name: "Resumo" }).click();
  await expect(page.getByText("Material colocado na fila.")).toBeVisible();
  const summary = page.locator("article").filter({ hasText: "Resumo · v1" });
  await expect(summary.getByText("Pronto", { exact: true })).toBeVisible({ timeout: 90_000 });

  await page.getByRole("button", { name: "Apostila", exact: true }).click();
  const notes = page.locator("article").filter({ hasText: "Apostila · v1" });
  await expect(notes.getByText("Pronto", { exact: true })).toBeVisible({ timeout: 90_000 });

  await page.getByRole("button", { name: "Flashcards", exact: true }).click();
  const flashcards = page.locator("article").filter({ hasText: "Flashcards · v1" });
  await expect(flashcards.getByText("Pronto", { exact: true })).toBeVisible({ timeout: 90_000 });
  const csvDownload = page.waitForEvent("download");
  await flashcards.getByRole("button", { name: /CSV Anki/ }).click();
  await expect((await csvDownload).suggestedFilename()).toMatch(/flashcards-v1\.csv$/);

  await page.getByRole("button", { name: "Questões", exact: true }).click();
  const questions = page.locator("article").filter({ hasText: "Questões · v1" });
  await expect(questions.getByText("Pronto", { exact: true })).toBeVisible({ timeout: 90_000 });

  await page.getByRole("button", { name: "Mapa mental", exact: true }).click();
  const mindmap = page.locator("article").filter({ hasText: "Mapa mental · v1" });
  await expect(mindmap.getByText("Pronto", { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(mindmap.getByLabel("Mapa mental")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "PDF da apostila", exact: true }).click();
  const pdf = page.locator("article").filter({ hasText: "PDF da apostila · v1" });
  await expect(pdf.getByText("Pronto", { exact: true })).toBeVisible({ timeout: 90_000 });
  const href = await pdf.getByRole("link", { name: /Baixar/ }).getAttribute("href");
  expect(href).toBeTruthy();
  const pdfResponse = await page.request.get(href!);
  expect(pdfResponse.ok()).toBe(true);
  expect((await pdfResponse.body()).subarray(0, 4).toString()).toBe("%PDF");
});
