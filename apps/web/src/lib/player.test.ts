import { describe, expect, it } from "vitest";
import { seekAudio } from "./player";

describe("seekAudio", () => {
  it("converte milissegundos para currentTime em segundos", () => {
    const audio = { currentTime: 0 };
    seekAudio(audio, 65_500);
    expect(audio.currentTime).toBe(65.5);
  });
});
