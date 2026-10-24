// Browser transport for a Boson Higgs Avatar session. Both LiveKit tracks are
// placed in one MediaStream so the browser presents voice and face together.
export function createLiveAvatarClient({ video, frame, onPlaybackFinished, onVideoChange }) {
  let session = null;
  let room = null;
  let relay = null;
  let audioTrack = null;
  let videoTrack = null;

  function showVideo(visible) {
    frame.dataset.liveVideo = String(visible);
    video.classList.toggle('hidden', !visible);
    onVideoChange?.(visible);
  }

  function send(type, delta) {
    if (!relay || relay.readyState !== WebSocket.OPEN) return;
    relay.send(JSON.stringify({ type, ...(delta ? { delta } : {}) }));
  }

  function attachVideoAndAudio() {
    if (!videoTrack) return;
    // LiveKit's video attach prepares adaptive streaming on the element. Keep
    // its video stream and add the matching Boson audio track to that same
    // MediaStream; attaching each track independently would replace srcObject.
    videoTrack.attach(video);
    const stream = video.srcObject;
    const mediaTrack = audioTrack?.mediaStreamTrack;
    if (stream && mediaTrack && !stream.getAudioTracks().includes(mediaTrack)) stream.addTrack(mediaTrack);
    video.muted = false;
    video.play().catch(() => {});
  }

  async function start(avatarId) {
    if (!window.LivekitClient) throw new Error('The LiveKit browser client did not load. Refresh the page.');
    const response = await fetch('/api/live-avatar/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatar_id: avatarId }),
    });
    const data = await response.json();
    if (!response.ok) {
      const detail = data.error || {};
      const codes = [detail.type, detail.code].filter(Boolean).join(' · ');
      const retryAfter = response.headers.get('Retry-After');
      const requestId = response.headers.get('X-Boson-Request-ID');
      const error = new Error(`${detail.message || 'Live avatar setup failed.'}${codes ? ` [${codes}]` : ''} (HTTP ${response.status}).${retryAfter ? ` Retry after ${retryAfter} seconds.` : ''}${requestId ? ` Boson request ID: ${requestId}.` : ''}`);
      error.status = response.status;
      error.code = detail.code;
      error.retryAfter = Number(retryAfter) || 5;
      throw error;
    }
    session = data;
    const { Room, RoomEvent } = window.LivekitClient;
    room = new Room({ adaptiveStream: true, dynacast: true });
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (participant.identity !== data.avatar_identity) return;
      if (track.kind === 'video') {
        videoTrack = track;
        attachVideoAndAudio();
        showVideo(true);
      } else if (track.kind === 'audio') {
        audioTrack = track;
        attachVideoAndAudio();
        room.startAudio().catch(() => {});
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
      if (participant.identity !== data.avatar_identity) return;
      if (track === audioTrack) {
        const stream = video.srcObject;
        if (stream && audioTrack.mediaStreamTrack) stream.removeTrack(audioTrack.mediaStreamTrack);
        audioTrack = null;
      }
      if (track === videoTrack) {
        track.detach(video);
        videoTrack = null;
        showVideo(false);
      }
    });
    room.on(RoomEvent.Disconnected, () => showVideo(false));
    await room.connect(data.livekit_url, data.viewer_token);

    const wsUrl = new URL(`/api/live-avatar/sessions/${encodeURIComponent(data.session_id)}/audio`, location.href);
    wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    relay = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting the avatar audio stream.')), 8000);
      relay.onopen = () => relay.send(JSON.stringify({ type: 'auth', token: data.relay_token }));
      relay.onmessage = (event) => {
        let message; try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'ready') { clearTimeout(timer); resolve(); }
        if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.message || 'Avatar audio stream failed.')); }
        if (message.type === 'playback_finished') onPlaybackFinished?.(message);
      };
      relay.onerror = () => { clearTimeout(timer); reject(new Error('Could not connect the avatar audio stream.')); };
    });
    return data;
  }

  async function stop() {
    const previousSession = session;
    session = null;
    const previousRelay = relay;
    relay = null;
    if (previousRelay && previousRelay.readyState < WebSocket.CLOSING) previousRelay.close();
    const previousRoom = room;
    room = null;
    if (previousRoom) { try { await previousRoom.disconnect(); } catch {} }
    try { videoTrack?.detach(video); } catch {}
    audioTrack = null;
    videoTrack = null;
    video.pause();
    video.muted = false;
    video.srcObject = null;
    showVideo(false);
    if (previousSession?.session_id) {
      try {
        await fetch(`/api/live-avatar/sessions/${encodeURIComponent(previousSession.session_id)}`, { method: 'DELETE', keepalive: true });
      } catch {}
    }
  }

  return {
    start, stop,
    audio: (delta) => { video.muted = false; if (audioTrack) video.play().catch(() => {}); send('audio', delta); },
    flush: () => send('flush'),
    clear: () => { video.muted = true; send('clear'); },
    get active() { return Boolean(session); },
    get sessionId() { return session?.session_id || null; },
  };
}
