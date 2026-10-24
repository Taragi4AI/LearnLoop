// LearnLoop — pure helpers for live Looper chat synchronization.
//
// DOM-free so they can be unit-tested in Node (node --test). learn.js wires
// these decisions to real chat bubbles. Each function encodes one rule the
// live-chat spec requires: stale-response rejection, final-vs-streamed
// reconciliation, and the auto-scroll "follow" decision.

/**
 * Should a text event for `eventResponseId` be applied to the bubble currently
 * keyed to `activeResponseId` / `bubbleResponseId`? A delta/done from a
 * SUPERSEDED (older) response must not modify a newer message.
 * Missing ids (provider didn't supply them) fall back to "apply".
 */
export function shouldApplyResponseEvent(eventResponseId, activeResponseId, bubbleResponseId) {
  if (!eventResponseId) return true;                 // no id → best-effort apply
  if (activeResponseId && eventResponseId !== activeResponseId
      && bubbleResponseId && bubbleResponseId !== eventResponseId) {
    return false;                                    // stale: belongs to a different, older response
  }
  return true;
}

/**
 * Reconcile authoritative final text with what was streamed, WITHOUT
 * double-appending. Returns the text to display (or null to keep streamed text).
 * Only replaces when the final is a strict superset/different and at least as
 * long as the streamed text (so a truncated final never erases good text).
 */
export function reconcileFinalText(streamed, finalText) {
  streamed = streamed || '';
  if (!finalText) return null;                       // nothing authoritative → keep streamed
  if (finalText === streamed) return null;           // identical → no change (no duplicate)
  if (finalText.length >= streamed.length) return finalText;  // extends/corrects → use it
  return null;                                       // final shorter → keep the fuller streamed text
}

/**
 * Decide whether to auto-scroll to the latest message. We follow the bottom
 * only when the user is already pinned there; otherwise we leave them reading
 * older content and signal that a jump control should be shown.
 * Returns { scroll: boolean, showJump: boolean }.
 */
export function autoScrollDecision(followingBottom) {
  return followingBottom ? { scroll: true, showJump: false }
                         : { scroll: false, showJump: true };
}
