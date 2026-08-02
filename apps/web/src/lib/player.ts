export function seekAudio(audio: Pick<HTMLAudioElement, "currentTime">, startMs: number) {
  audio.currentTime = Math.max(0, startMs) / 1000;
}
