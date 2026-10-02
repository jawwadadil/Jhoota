(() => {
  let room = null, generation = 0, muted = true;
  const notify = (state, message = '') => {
    const speakers = room ? room.activeSpeakers.map(p => p.identity) : [];
    window.CallBridge?.status(JSON.stringify({ state, message, muted,
      count: room ? room.remoteParticipants.size + 1 : 0, speakers }));
  };
  window.JhootaCall = {
    async connect(url, token) {
      await this.leave(true);
      const attempt = ++generation;
      if (!window.LivekitClient) { notify('error', 'Call audio library could not load. Check your internet connection.'); return; }
      const { Room, RoomEvent, Track } = window.LivekitClient;
      const current = new Room({ adaptiveStream: false, dynacast: true });
      room = current; muted = true; notify('connecting');
      const update = () => { if (room === current) notify('connected'); };
      current.on(RoomEvent.TrackSubscribed, track => {
        if (track.kind === Track.Kind.Audio && room === current) document.getElementById('audio').appendChild(track.attach());
      });
      current.on(RoomEvent.TrackUnsubscribed, track => track.detach().forEach(el => el.remove()));
      current.on(RoomEvent.ActiveSpeakersChanged, update);
      current.on(RoomEvent.ParticipantConnected, update);
      current.on(RoomEvent.ParticipantDisconnected, update);
      current.on(RoomEvent.Reconnecting, () => { if (room === current) notify('reconnecting'); });
      current.on(RoomEvent.Reconnected, update);
      current.on(RoomEvent.Disconnected, () => {
        if (room === current) { room = null; document.getElementById('audio').replaceChildren(); notify('idle'); }
      });
      try {
        await current.connect(url, token);
        if (attempt !== generation) { await current.disconnect(); return; }
        await current.startAudio();
        notify('connected');
      } catch (error) {
        if (attempt !== generation) return;
        await current.disconnect(); room = null;
        notify('error', 'Could not join the call. Check LiveKit settings and internet, then retry.');
      }
    },
    async setMuted(value) {
      if (!room) return;
      const current = room;
      try {
        await current.localParticipant.setMicrophoneEnabled(!value, { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
        if (room === current) { muted = value; notify('connected'); }
      } catch { notify('error', 'Microphone could not start. Check microphone permission and retry.'); }
    },
    async leave(quiet = false) {
      ++generation;
      const previous = room; room = null; muted = true;
      if (previous) await previous.disconnect();
      document.getElementById('audio').replaceChildren(); if (!quiet) notify('idle');
    },
  };
})();
