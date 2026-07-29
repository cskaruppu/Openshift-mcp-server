# Recording toolkit — video, audio, and getting them to match

For the UC-05 RCA Agent demo. Companion to [`UC-05-RCA-Agent-Demo-Script.md`](./UC-05-RCA-Agent-Demo-Script.md).

> **The short version.** Record the **audio first**, then cut the video to fit it. Use OBS to
> capture, Adobe Podcast Enhance (free) to clean the voice, and Clipchamp to assemble. If you would
> rather not narrate in your own voice, generate it from
> [`UC-05-narration-only.txt`](./UC-05-narration-only.txt) — that file is built for exactly that.

---

## 1. The one decision that matters: audio-led, not video-led

Almost every demo recording that feels amateur was made video-first — record the screen, then try to
talk over it. It fails because the two drift, and audio cannot be stretched to fix it without
sounding wrong.

Do it the other way round:

```
1.  Record the narration alone.  No screen, no pressure, redo lines freely.
2.  Clean and normalise it.      (§3)
3.  Drop it on the timeline.     Now the timing is fixed and known.
4.  Record the screen actions.   Roughly, unhurried — you are not performing to a clock.
5.  Trim the video to the audio. Cut dead frames, speed up scrolls and page loads.
```

Video is trivially retimeable — trim a pause, speed a scroll to 2×, hold a still frame. Audio is
not. So let the audio be the master and make the picture serve it.

**This is why the script carries cue points.** Each of the ten blocks in `UC-05-narration-only.txt`
has a cue (`CUE 2:38`) and a screen name. Place markers at those ten timestamps on the Clipchamp
timeline, then fit each screen segment between its markers. The demo self-assembles.

---

## 2. Capture

| Tool | Cost | Use it for |
|---|---|---|
| **OBS Studio** | Free | **Recommended.** Records screen and microphone to *separate tracks*, so you can process the voice without touching the picture. Also lets you record audio alone for step 1. |
| **Clipchamp** | Free, built into Windows 11 | Assembly and export. Its own screen recorder is fine but mixes audio into one track — usable, less flexible. |
| **Windows Game Bar** (`Win`+`G`) | Free, built in | Quick grabs only. No region control. |

**OBS settings that matter:** 1920×1080, 30 fps, and set the mic to a *separate audio track*
(Settings → Output → Recording → Audio Track 2). Record to MKV, then File → Remux to MP4 — MKV
survives a crash mid-recording, MP4 does not.

---

## 3. Audio quality — where "professional" actually comes from

In order of impact. The first two matter more than anything you do in software.

### ① The microphone — the single biggest jump

A laptop's built-in mic sounds like a laptop's built-in mic and no processing fully hides it.

| Option | Rough cost | Verdict |
|---|---|---|
| **Samson Q2U** / **Rode NT-USB Mini** | ~$70–100 | Genuine studio-adjacent quality. The Q2U is USB *and* XLR, so it outlasts the laptop. |
| **Any wired headset with a boom mic** | ~$25 | Not glamorous, but the boom keeps a fixed distance from your mouth, which is most of the battle. Far better than a laptop mic. |
| **Bluetooth earbuds / AirPods** | — | **Avoid.** Bluetooth mic profiles crush voice bandwidth. They sound like a phone call. |

Position it a hand's width from your mouth, slightly off-axis so plosives ("p", "b") miss it.

### ② The room — free, and worth more than any plugin

Hard walls create reverb, and reverb is the thing that reads as "recorded at a desk". Soft surfaces
absorb it.

- Record in a room with carpet, curtains, a sofa — not a bare meeting room or a tiled space
- Avoid sitting directly in front of a hard wall; face into the room, or into a corner with fabric
- Turn off the air conditioning and the fan for the take
- If your laptop fan spins up, pause and let it settle — it will be audible

### ③ Processing — free, and genuinely transformative

| Tool | Cost | What it does |
|---|---|---|
| **Adobe Podcast Enhance** — `podcast.adobe.com/enhance` | **Free**, browser, no install | Upload the raw voice track, download it sounding as though it were recorded in a treated studio. Removes room reverb and background noise, evens out level. This is the highest-return five minutes in the entire process — do this even if everything else is perfect. |
| **Auphonic** — `auphonic.com` | Free tier, 2 h/month | Loudness-normalises to broadcast standard (-16 LUFS). Use *after* Enhance if you want the level to match professionally produced video exactly. |
| **Audacity** | Free | Manual fallback: Noise Reduction, then Compressor, then Normalize to -1 dB. Only if you want the control. |

**Run the raw track through Adobe Enhance before you do anything else.** It is the difference
between "someone recorded a demo" and "this is a product video".

---

## 4. If you would rather not narrate it yourself

Entirely legitimate for a customer-facing product video, and it solves the timing problem outright —
synthesised narration is consistent, has no fluffed lines, and can be regenerated per block when you
change a word.

[`UC-05-narration-only.txt`](./UC-05-narration-only.txt) is built for this: ten blocks, each with its
cue point, stage directions stripped, paragraph breaks preserved so the engine pauses in the right
places.

| Tool | Cost | Notes |
|---|---|---|
| **ElevenLabs** — `elevenlabs.io` | Free tier ≈ 10 min/month | Best quality available. Paste one block at a time, download, place at its cue. Also clones your own voice from a few minutes of sample if you want it to sound like you without having to perform it. |
| **Clipchamp text-to-speech** | Free, already installed | Built into the editor you are using. Noticeably more synthetic than ElevenLabs, but zero extra tooling and the timeline placement is automatic. |
| **Microsoft Azure Speech** | Free tier | The `en-GB-RyanNeural` / `en-IN-PrabhatNeural` voices are strong. Overkill unless you are producing several of these. |

**Render one block per file, not the whole script as one.** Changing a sentence then costs one
re-render, not ten minutes of re-reading — and each file lands at a known cue point.

**Say these out loud once before you commit to a voice** — TTS engines mangle them, and you may need
to respell them phonetically in the input:

| Written | Often comes out as | Fix |
|---|---|---|
| OOMKilled | "oom-killed" / "O-O-M-killed" | Not in the script — kept out deliberately |
| ITIL | "eye-till" or spelled out | Write `eye-till` |
| ITSM | usually fine spelled out | — |
| Kubernetes | usually fine | — |
| RCA | usually fine spelled out | — |
| dry-run | occasionally "dryrun" | Write `dry run` |

---

## 5. Assembly in Clipchamp

1. Import the cleaned audio (or the ten TTS blocks) **first**. Lay them on the timeline at their cue
   points: 0:00, 0:18, 0:41, 2:00, 2:31, 2:38, 3:15, 3:50, 4:07, 4:32.
2. Import the screen capture. Fit each segment between the markers — trim the front, speed up any
   scroll or page load that runs long.
3. Cut every silence over ~1 second **except** the two deliberate pauses (block 3 and block 9).
4. Zoom in on the root-cause paragraph (~3:23) and the before/after container table (~4:18). Text
   that is readable on your monitor is not readable in a compressed 1080p video.
5. Three text overlays during block 3: **"20 automatic"**, **"1 AI"**, **"1 human decision"**.
6. Auto-generate captions, then **proofread them** — "ServiceNow", "ITIL", "Kubernetes" and
   "OpenShift" will be mis-transcribed, and wrong captions undermine a technical demo badly.
7. Export 1080p MP4.

---

## 6. Minimum viable setup

If you want to spend nothing and no time:

```
Capture      OBS Studio, separate audio tracks
Microphone   Any wired headset you already own — not the laptop, not Bluetooth
Room         Somewhere with soft furnishings, AC off
Clean        Adobe Podcast Enhance (free, browser, one upload)
Assemble     Clipchamp, audio first, markers at the ten cue points
Export       1080p MP4
```

The headset and the Adobe Enhance pass are the two steps that carry most of the quality. Neither
costs anything if you own a headset.
