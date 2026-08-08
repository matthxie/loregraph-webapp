/** Encode mono Web Audio samples as 16-bit PCM WAV for the hosted dictation endpoint. */
export function encodePcm16Wav(chunks: readonly Float32Array[], sampleRate: number): ArrayBuffer {
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new Error("invalid microphone sample rate");
  }
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytesPerSample = 2;
  const dataBytes = sampleCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, Math.round(sampleRate), true);
  view.setUint32(28, Math.round(sampleRate) * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (const raw of chunk) {
      const sample = Math.max(-1, Math.min(1, raw));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

/** Downsample microphone PCM to a compact mono rate before crossing IPC. */
export function resamplePcm(
  chunks: readonly Float32Array[],
  sourceRate: number,
  targetRate = 16_000,
): Float32Array {
  if (
    !Number.isFinite(sourceRate) ||
    !Number.isFinite(targetRate) ||
    sourceRate < targetRate ||
    targetRate < 8_000
  ) {
    throw new Error("invalid voice resampling rate");
  }
  const inputLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const input = new Float32Array(inputLength);
  let writeOffset = 0;
  for (const chunk of chunks) {
    input.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  if (sourceRate === targetRate) return input;

  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.floor(inputLength / ratio));
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.max(start + 1, Math.min(input.length, Math.floor((outputIndex + 1) * ratio)));
    let sum = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) sum += input[inputIndex]!;
    output[outputIndex] = sum / (end - start);
  }
  return output;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}
