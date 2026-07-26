/**
 * Fire haptic feedback where the platform supports it.
 *
 * Android (Chrome PWA): works via the Vibration API.
 * iOS (Safari/PWA): the Vibration API is not implemented — this is a
 * silent no-op. There is currently no web API for programmatic haptics
 * on iOS; only native apps get access to the Taptic Engine.
 */
export function haptic(pattern: number | number[] = 10): void {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(pattern);
    }
  } catch {
    // never let haptics break anything
  }
}

export const HAPTIC = {
  tap: 10,
  success: 20,
  pr: [30, 60, 30] as number[],
};
