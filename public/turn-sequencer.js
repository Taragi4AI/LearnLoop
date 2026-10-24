// Pure, testable turn sequencer for Looper (G4 race fix).
//
// Problem (LL-G4-TEST-002): with server_vad, Higgs Realtime auto-generates a
// response the instant the user stops speaking — BEFORE LearnLoop can retrieve
// and inject question-specific transcript context. The context then lands a
// turn late. Docs confirm: "With server VAD active, the model automatically
// responds when you stop speaking."
//
// Fix: MANUAL turn control. The client owns the order per turn:
//   commit audio -> transcription.completed (question) -> retrieve context ->
//   inject context -> response.create. The model only answers AFTER context is
//   injected, so no race.
//
// This module encodes the ordering + stale-result guards with NO DOM/WS/network
// so it is deterministically unit-testable. The host supplies async callbacks.

export function createTurnSequencer({ fetchContext, inject, requestResponse, onError } = {}) {
  let turnSeq = 0;            // increments each committed turn
  let activeLectureId = null; // current lecture; late results for others are dropped
  const inflight = new Map(); // turnId -> { lectureId, done }

  function setLecture(id) { activeLectureId = id; }

  /** Called when a user turn's transcription completes. Retrieves context for
   *  THIS turn's question, injects it, then requests the response — in order.
   *  Guards against stale lecture and out-of-order completion. Returns a trace
   *  array of ordered step markers for testing/observability. */
  async function handleUserTurn(question, { lectureId, position } = {}) {
    const turnId = ++turnSeq;
    const trace = [];
    inflight.set(turnId, { lectureId, done: false });
    trace.push({ step: 'turn_started', turnId, lectureId });

    // Stale-lecture guard at entry.
    if (lectureId !== activeLectureId) {
      trace.push({ step: 'dropped_stale_lecture_entry', turnId });
      inflight.delete(turnId);
      return trace;
    }

    let ctx;
    try {
      ctx = await fetchContext({ question, lectureId, position, turnId });
      trace.push({ step: 'context_retrieved', turnId });
    } catch (err) {
      trace.push({ step: 'context_failed', turnId });
      onError && onError('context_fetch_failed', err, { turnId, lectureId });
      // Do NOT silently claim context applied. Still answer, but mark ungrounded.
      try { await requestResponse({ turnId, grounded: false }); trace.push({ step: 'response_requested_ungrounded', turnId }); }
      catch (e2) { onError && onError('response_failed', e2, { turnId, lectureId }); }
      inflight.delete(turnId);
      return trace;
    }

    // Stale guards AFTER the async fetch: a newer turn or a lecture switch may
    // have occurred while we were awaiting context.
    if (lectureId !== activeLectureId) {
      trace.push({ step: 'dropped_stale_lecture_after_fetch', turnId });
      inflight.delete(turnId);
      return trace;
    }
    if (turnId !== turnSeq) {
      // A later turn started; this turn's context must not be injected now
      // (it would contaminate the newer question). Drop it.
      trace.push({ step: 'dropped_superseded_turn', turnId, latest: turnSeq });
      inflight.delete(turnId);
      return trace;
    }

    // Inject context, THEN request the response — the core ordering guarantee.
    inject(ctx, { turnId });
    trace.push({ step: 'context_injected', turnId });
    await requestResponse({ turnId, grounded: true });
    trace.push({ step: 'response_requested', turnId });

    inflight.delete(turnId);
    return trace;
  }

  return {
    setLecture,
    handleUserTurn,
    get turnSeq() { return turnSeq; },
    get activeLectureId() { return activeLectureId; },
  };
}
