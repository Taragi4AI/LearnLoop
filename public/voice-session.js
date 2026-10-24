// Small, dependency-free voice-session policy helpers.  Keeping these pure makes
// the safety-critical command and detector rules easy to test outside the DOM.

/**
 * True only for a direct request to stop Jarvis.  In particular, this does not
 * match narrative text such as "I stopped listening earlier".
 */
export function isStopListeningCommand(text) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[.,!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const address = '(?:(?:hey )?(?:jarvis|looper) )?';
  const polite = '(?:(?:can|could|would) you )?(?:please )?';
  const ending = '(?: now| please)?';
  const command = '(?:stop(?: (?:listening|talking|jarvis|looper|the (?:listening )?session|the conversation))?|be quiet|go to sleep|end (?:the |our )?conversation|end (?:the )?session)';
  return new RegExp(`^${address}${polite}${command}${ending}$`).test(s);
}

/**
 * Privacy-safe fallback until a vetted browser-local diarization/overlap model
 * is shipped.  VAD/volume alone cannot identify people, so this intentionally
 * never reports multiple speakers.  A real detector implements the same
 * start({ stream, onMultipleSpeakers }) / stop() interface.
 */
export function createDisabledMultiSpeakerDetector({ onStatus } = {}) {
  let running = false;
  return {
    enabled: false,
    async start() {
      running = true;
      onStatus?.({ enabled: false, reason: 'No reliable local multi-speaker model is installed.' });
      // TODO: add a vetted, browser-local diarization or overlap model here.
    },
    stop() { running = false; },
    get running() { return running; },
  };
}
