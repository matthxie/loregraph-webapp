import { describe, expect, it } from "vitest";
import { encodePcm16Wav, resamplePcm } from "./voiceWav";

function ascii(view: DataView, offset: number, length: number): string {
  return String.fromCharCode(
    ...Array.from({ length }, (_, index) => view.getUint8(offset + index)),
  );
}

describe("encodePcm16Wav", () => {
  it("writes a mono 16-bit PCM WAV with clamped samples", () => {
    const result = encodePcm16Wav([
      new Float32Array([-2, -0.5]),
      new Float32Array([0, 0.5, 2]),
    ], 48_000);
    const view = new DataView(result);

    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(ascii(view, 36, 4)).toBe("data");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(10);
    expect(result.byteLength).toBe(54);
    expect(view.getInt16(44, true)).toBe(-32_768);
    expect(view.getInt16(52, true)).toBe(32_767);
  });

  it("rejects an invalid sample rate", () => {
    expect(() => encodePcm16Wav([], 0)).toThrow(/sample rate/);
  });

  it("downsamples chunks before IPC", () => {
    const output = resamplePcm([
      new Float32Array([0, 0.5, 1]),
      new Float32Array([1, 0.5, 0]),
    ], 48_000, 16_000);
    expect(Array.from(output)).toEqual([0.5, 0.5]);
  });
});
