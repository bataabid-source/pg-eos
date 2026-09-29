// WBS 2.16 part 2 — sound + vibration feedback for a scan (doc 40 §D4: error prevented with
// sound+vibration). Every browser API is guarded: a device without it stays silent, never throws.
export interface ScanSignal {
  ok(): void;
  error(): void;
}

const OK_VIBRATION_MS = 60;
const ERROR_VIBRATION_PATTERN_MS: readonly number[] = [200, 80, 200];
const OK_TONE_HZ = 880;
const ERROR_TONE_HZ = 220;
const OK_TONE_MS = 80;
const ERROR_TONE_MS = 400;
const MS_PER_SECOND = 1000;

interface AudioWindow {
  AudioContext?: typeof AudioContext;
}

function vibrate(pattern: number | readonly number[]): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(typeof pattern === 'number' ? pattern : [...pattern]);
  }
}

function tone(frequencyHz: number, durationMs: number): void {
  if (typeof window === 'undefined') {
    return;
  }
  const Ctor = (window as unknown as AudioWindow).AudioContext;
  if (Ctor === undefined) {
    return;
  }
  try {
    const context = new Ctor();
    const oscillator = context.createOscillator();
    oscillator.frequency.value = frequencyHz;
    oscillator.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + durationMs / MS_PER_SECOND);
    oscillator.onended = () => {
      void context.close();
    };
  } catch {
    // audio unavailable or blocked: the vibration and the on-screen message still signal.
  }
}

export const browserScanSignal: ScanSignal = {
  ok: () => {
    vibrate(OK_VIBRATION_MS);
    tone(OK_TONE_HZ, OK_TONE_MS);
  },
  error: () => {
    vibrate(ERROR_VIBRATION_PATTERN_MS);
    tone(ERROR_TONE_HZ, ERROR_TONE_MS);
  },
};
