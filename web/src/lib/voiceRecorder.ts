/**
 * Microphone capture for the dictation mic buttons (Ask popup + write composer).
 *
 * Captures mono Float32 chunks off a ScriptProcessor — the same simple, battle-tested path
 * the popup shipped with before voice was removed in 35aa860. The caller owns the state
 * machine (recording/transcribing UI, max-duration timer) and turns the chunks into a WAV
 * with voiceWav.ts before handing them over IPC to main, which posts them to OpenAI's
 * transcription endpoint (voiceTranscriber.ts) — dictation is hosted, not on-device.
 */

export interface VoiceCapture {
  /** Samples recorded so far; grows live while capturing. */
  readonly chunks: readonly Float32Array[];
  readonly sampleRate: number;
  /** Stop tracks and release the AudioContext. Idempotent; chunks stay readable. */
  dispose(): void;
}

export async function startVoiceCapture(): Promise<VoiceCapture> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone recording is unavailable on this device");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  const context = new AudioContext();
  await context.resume();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4_096, 1, 1);
  // A muted sink keeps the processor pulling samples without feeding the mic back out.
  const silentGain = context.createGain();
  silentGain.gain.value = 0;
  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (event) => {
    chunks.push(Float32Array.from(event.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(context.destination);

  let disposed = false;
  return {
    chunks,
    sampleRate: context.sampleRate,
    dispose() {
      if (disposed) return;
      disposed = true;
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      silentGain.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void context.close().catch(() => undefined);
    },
  };
}
