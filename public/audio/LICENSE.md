# Focus timer audio assets — provenance & license

The focus timer's optional device effects (MR ②, #41) reference two bundled
audio assets:

| File            | Purpose                                   | Status                       |
| --------------- | ----------------------------------------- | ---------------------------- |
| `alarm.wav`     | Short chime at time's-up (alarm)          | **Real, audible** ✅         |
| `lofi-calm.mp3` | Looping calm background bed (focus sound) | Silent placeholder (see #43) |

## License

**CC0 1.0 (public domain dedication)** for both files — self-authored, no
third-party copyright.

## Provenance / status

- **`alarm.wav` — a real, audible chime.** Synthesized programmatically (a gentle
  3× two-tone A5/D6 chime, enveloped to avoid clicks; 16-bit PCM, 44.1 kHz, mono,
  ~1.3 s). Self-authored, so the CC0 dedication is accurate and safe to ship.
- **`lofi-calm.mp3` — still a silent placeholder.** Valid MPEG-1 Layer III,
  generated programmatically (self-authored, silent) so the audio pipeline
  (asset paths, `FOCUS_SOUND_SRC`, the looping player) is real and buildable
  end-to-end, but it produces no sound yet.

> **Follow-up (#43, v0.3.0):** replace `lofi-calm.mp3` with a real, curated
> free-to-use lofi library (owner sourced https://github.com/btahir/open-lofi),
> add a settings picker with per-track preview, and an embedded mini-player /
> playlist in `/focus`. When tracks are added, record each track's source URL,
> author, and license here.

Streaming sources (YouTube / Spotify / SoundCloud) are explicitly a **future**
release and are intentionally not present here.
