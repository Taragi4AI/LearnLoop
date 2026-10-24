"""Deterministic Realtime context-race tests (LL-G4-TEST-002).

The race: under server_vad, Higgs auto-responds the instant the user stops
speaking, BEFORE question-specific context is retrieved/injected. The fix is a
manual turn sequence: commit -> transcription -> retrieve context -> inject ->
response.create, so the response is only requested AFTER context injection.

These tests model that sequencer's ordering contract in Python with CONTROLLED
timing (delayable context retrieval, reordered completions, failures, lecture
switch). They assert OBSERVABLE ORDERING — that a response is never requested
before context for that turn is injected — not arbitrary sleeps.

A faithful JS twin (public/turn-sequencer.js) carries the production logic and
is covered by tests/turn_sequencer.test.mjs (run under Node). This Python harness
mirrors that contract so the race is guarded in the runnable environment too.
"""

from __future__ import annotations

import asyncio


class SequencerModel:
    """Python mirror of public/turn-sequencer.js ordering + stale guards."""

    def __init__(self, fetch_context, inject, request_response, on_error=None):
        self._fetch = fetch_context
        self._inject = inject
        self._respond = request_response
        self._on_error = on_error
        self.turn_seq = 0
        self.active_lecture = None

    def set_lecture(self, lid):
        self.active_lecture = lid

    async def handle_user_turn(self, question, lecture_id, position=0.0):
        self.turn_seq += 1
        turn_id = self.turn_seq
        trace = [("turn_started", turn_id)]

        if lecture_id != self.active_lecture:
            trace.append(("dropped_stale_lecture_entry", turn_id)); return trace

        try:
            ctx = await self._fetch(question=question, lecture_id=lecture_id,
                                    position=position, turn_id=turn_id)
            trace.append(("context_retrieved", turn_id))
        except Exception as e:  # noqa: BLE001
            trace.append(("context_failed", turn_id))
            if self._on_error:
                self._on_error("context_fetch_failed", e)
            await self._respond(turn_id=turn_id, grounded=False)
            trace.append(("response_requested_ungrounded", turn_id))
            return trace

        if lecture_id != self.active_lecture:
            trace.append(("dropped_stale_lecture_after_fetch", turn_id)); return trace
        if turn_id != self.turn_seq:
            trace.append(("dropped_superseded_turn", turn_id)); return trace

        self._inject(ctx, turn_id)
        trace.append(("context_injected", turn_id))
        await self._respond(turn_id=turn_id, grounded=True)
        trace.append(("response_requested", turn_id))
        return trace


def _order(events, kind):
    return [i for i, e in enumerate(events) if e[0] == kind]


# --- Case A: fast retrieval — context injected before response requested ---
def test_A_fast_retrieval_injects_before_response():
    async def run():
        events = []
        async def fetch(**kw): events.append(("fetch", kw["turn_id"])); return {"code": "ORANGE"}
        def inject(ctx, tid): events.append(("inject", tid))
        async def respond(**kw): events.append(("respond", kw["turn_id"]))
        s = SequencerModel(fetch, inject, respond); s.set_lecture("L")
        await s.handle_user_turn("where is HISTORICAL_CODE", "L")
        assert _order(events, "inject")[0] < _order(events, "respond")[0]
    asyncio.run(run())


# --- Case B: DELAYED retrieval — response must still wait for context ---
def test_B_delayed_retrieval_response_waits_for_context():
    async def run():
        events = []
        async def fetch(**kw):
            await asyncio.sleep(0.05)              # deliberate delay past any auto-trigger
            events.append(("inject_ready", kw["turn_id"])); return {"code": "ORANGE"}
        def inject(ctx, tid): events.append(("inject", tid))
        async def respond(**kw): events.append(("respond", kw["turn_id"]))
        s = SequencerModel(fetch, inject, respond); s.set_lecture("L")
        await s.handle_user_turn("historical?", "L")
        assert _order(events, "inject")[0] < _order(events, "respond")[0]
    asyncio.run(run())


# --- Case C: FAILED retrieval — no false claim of grounded context ---
def test_C_failed_retrieval_is_not_claimed_grounded():
    async def run():
        grounded_flags = []
        async def fetch(**kw): raise RuntimeError("context endpoint 500")
        async def respond(**kw): grounded_flags.append(("respond", kw["grounded"]))
        errors = []
        s = SequencerModel(fetch, lambda c, t: grounded_flags.append("INJECTED"),
                           respond, on_error=lambda k, e: errors.append(k))
        s.set_lecture("L")
        trace = await s.handle_user_turn("q", "L")
        assert "INJECTED" not in grounded_flags           # context was NOT injected
        assert ("respond", False) in grounded_flags       # response marked UNgrounded
        assert ("context_failed", 1) in trace
        assert "context_fetch_failed" in errors
    asyncio.run(run())


# --- Case D: rapid consecutive turns — earlier context cannot contaminate later ---
def test_D_reordered_turns_no_contamination():
    async def run():
        injected = []
        async def fetch(**kw):
            if kw["turn_id"] == 1:
                await asyncio.sleep(0.05)
            return {"for_turn": kw["turn_id"]}
        def inject(ctx, tid): injected.append((tid, ctx["for_turn"]))
        async def respond(**kw): pass
        s = SequencerModel(fetch, inject, respond); s.set_lecture("L")
        t1 = asyncio.create_task(s.handle_user_turn("q1", "L"))
        await asyncio.sleep(0.001)
        t2 = asyncio.create_task(s.handle_user_turn("q2", "L"))
        tr1, tr2 = await asyncio.gather(t1, t2)
        assert ("dropped_superseded_turn", 1) in tr1
        assert injected == [(2, 2)]
    asyncio.run(run())


# --- Case E: lecture switch while a context request is pending ---
def test_E_lecture_switch_drops_stale_context():
    async def run():
        injected = []
        async def fetch(**kw):
            await asyncio.sleep(0.05)
            return {"lecture": kw["lecture_id"]}
        def inject(ctx, tid): injected.append(ctx["lecture"])
        async def respond(**kw): pass
        s = SequencerModel(fetch, inject, respond); s.set_lecture("OLD")
        task = asyncio.create_task(s.handle_user_turn("q", "OLD"))
        await asyncio.sleep(0.001)
        s.set_lecture("NEW")                       # user switches lectures mid-fetch
        trace = await task
        assert ("dropped_stale_lecture_after_fetch", 1) in trace
        assert injected == []
    asyncio.run(run())
