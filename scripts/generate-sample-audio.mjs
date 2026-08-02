import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve("tests/fixtures/aula-exemplo.wav");
mkdirSync(resolve("tests/fixtures"), { recursive: true });
const sampleRate = 16_000;
const durationSeconds = 6;
const sampleCount = sampleRate * durationSeconds;
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
    Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 8_000),
    44 + index * 2
  );
}
writeFileSync(output, wav);
console.log(`Áudio de exemplo criado em ${output}`);
