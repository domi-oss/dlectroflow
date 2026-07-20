# Focus timer audio assets — provenance & license

The focus timer's optional device effects (MR ②, #41) reference two bundled
audio assets:

| File            | Purpose                                  |
| --------------- | ---------------------------------------- |
| `lofi-calm.mp3` | Looping calm background bed (focus sound)|
| `alarm.mp3`     | Short chime at time's-up (alarm)         |

## License

**CC0 1.0 (public domain dedication).**

## Provenance / status

These files were **generated programmatically** (valid MPEG-1 Layer III,
128 kbps, 44.1 kHz, mono) as **self-authored, silent placeholders**. They carry
no third-party copyright, so the CC0 dedication above is accurate and safe to
ship. They make the audio pipeline (asset paths, `FOCUS_SOUND_SRC`, the looping
player, and the alarm) real and buildable end-to-end.

> **Follow-up (pre-release polish):** swap these silent placeholders for curated
> CC0 audio — e.g. a calm lo-fi loop and a soft chime from a CC0 source such as
> Pixabay Music or freesound.org (CC0 filter) — keeping the same filenames and
> the `lofi-calm.mp3` seamless-loop property. When you do, update this file with
> the source URL and author for each track. No code change is required; only the
> two binaries are replaced.

Streaming sources (YouTube / Spotify / SoundCloud) are explicitly a **future**
release and are intentionally not present here.
