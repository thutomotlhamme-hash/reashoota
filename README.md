# ReaShoota

A mobile-first music video studio for iPhone. Plan the video, add your song, then shoot straight into timed slots on a CapCut-style timeline. Captions and beat-synced edit effects are added for you, and you save one finished 9:16 video to Photos. It all keeps working with no signal.

It is a static PWA. There is no build step and nothing to install at runtime, so it can be deployed to any static host (Netlify config is included).

## The studio

- **Timeline:** every shot is a slot sized to its length, grouped by song section, over the song's waveform. Tap a slot to select it, **SHOOT** to film into it, **From Photos** to drop a clip in, and ▶ to play the whole edit with the song.
- **Camera:** a live viewfinder with a framing grid, the shot's direction and lyric, and a countdown. The song plays through the countdown so the artist comes in on time, and the take stops at exactly the slot's length. It then moves to the next empty slot. **iPhone camera** uses the native camera instead, for full 4K quality.
- **Templates (viral-ready):** Viral Hook 15, Beat Cut 30, Beat Drop 20, Verse → Chorus (60s), Performance + B-roll, and One-take Hook. Each sets the slot layout plus edit effects: *beat pulse* (a zoom bump on every beat), *flash cuts* and *punch-ins*. **Auto-fill** drops clips picked from Photos into the empty slots in order.
- **Song:** add an MP3/M4A/WAV. ReaShoota finds the BPM and draws the waveform. Pick Full, Best 30s (the loudest stretch), a 15s hook, or a custom range. **Build slots on the beat** snaps every cut to half-bars.
- **Lyrics & captions:** paste the lyrics, then **Tap to sync** once while the song plays. Captions appear word by word in one of four styles (Pop, Karaoke, Clean, Boxed) and six bundled fonts. They sit in the TikTok/Reels/Shorts safe zone, clear of the platform's buttons. Without syncing, each shot's lyric is spread across its slot.
- **Final video:** **Save → Make video** renders a 1080×1920 video at 12 Mbps. It includes the song, burned-in captions, the edit effects, and a fade in and out. Unfilmed slots reuse the nearest clip. You watch it live while it renders, then save it to Photos from the share sheet. Safari on iPhone produces H.264/AAC MP4.
- **Young-D-Guide (the timeline as creative director):** ReaShoota treats every lyric line, repeated hook, bass hit, drop-out, beat switch and ad-lib as a creative opportunity, and marks each one on the timeline (◆ lyric visual · ✦ weird · ○ easy practical · ⬡ AI/hybrid · ↗ transition · ⚡ hero moment). An echo card under the shot follows the playhead. Tap a marker to get:
  - the **association chain**: what the line means, how it feels, and the visual world it lives in;
  - a headline **visual echo** plus the other directions (Literal, Object rhyme, Metaphor, Weird/surreal, Practical, Premium/AI hybrid). Each comes with *why it connects*;
  - a **SAFE → STRANGE → UNHINGED** slider. Unhinged stays tied to the line, never random;
  - **SPIN THIS MOMENT** with modifiers (weirder, cheaper, more cinematic, street, luxury, emotional, minimal, surreal, solo shoot, AI version). Spin never repeats an idea you've already seen for that moment. There's also **More like this** and a per-idea ↻;
  - a **visual world** (water, glass, mirrors, ice, chrome, CCTV…). It grows from the ideas you pick, and later suggestions stay inside it.

  **USE THIS** turns an idea into a production shot in the slot at that moment: visual, why it connects, shot size, camera position, movement, lens, fps, lighting, location, props, how to shoot it, AI needs and cut points. The previous plan is kept for undo. In the camera it becomes a short **DO THIS** card: shot and timecode, lyric, three steps, camera, duration, START COUNTDOWN.

  The engine (`src/echo/`) runs entirely on the phone. It uses a hand-written library of about 220 original ideas across 32 lyric concepts plus sound-driven moments. Lines that match no concept get delivery-based ideas. A server-side AI generator could later add to this library through the same `suggest()` interface.
- **Plan** (list icon): the original shot list, storyboard, creative direction, image rhymes, lyric map, checklist, media and every document export.

Speech-to-text captions and AI clip generation need a server, and none ships with this repo yet.

## Download / export to phone

Every export opens a **ready sheet** with a preview and four big buttons:

| Button | What it does on iPhone |
| --- | --- |
| **SAVE TO PHONE** | Opens the native share sheet with just the file(s) → *Save Image* / *Save Video* (Photos) or *Save to Files* (iCloud Drive / On My iPhone) |
| **SHARE** | Share sheet with a message → AirDrop, Messages, WhatsApp, Mail, any installed app |
| **DOWNLOAD** | Classic download (Files › Downloads); opens the file in a viewer when running from the Home Screen |
| **COPY TEXT** | Copies the text version to the clipboard (text-based exports) |

The file is generated first and shared on your next tap. iOS only opens the share sheet straight from a tap, so this two-step flow works reliably.

Obvious entry points: the **Export** tab has DOWNLOAD SHOOT PACK, SAVE STORYBOARD, SAVE VIDEO, COPY SHOT LIST, SHARE PROJECT and MAKE AVAILABLE OFFLINE. Every other tab has a fixed **SAVE / SHARE / COPY** bar for the thing on screen. Board panels, shot cards and media items each have their own save button.

| Export | Formats |
| --- | --- |
| Shoot pack (shot list + camera + locations/props + checklist) | PDF, text |
| Full production pack | PDF, Markdown, text |
| Storyboard | PDF grid, one tall image, every frame to Photos, text |
| Shot list | PDF, text, Markdown, copy |
| Concept deck (client/artist) | PDF (landscape) |
| Creative direction pack, Image-Rhyme breakdown, Lyrics → shot map | PDF, Markdown, text |
| Camera instructions, Locations & props, Shoot checklist, Project summary | PDF, text (+ Markdown) |
| Shot cards | 9:16 PNG/JPG, one per shot |
| Moodboard | PNG/JPG |
| Individual reference frames, concept images | original file |
| AI video clips, edited videos | original file (MP4/MOV) via SAVE VIDEO |
| **Your video** | the finished 9:16 edit: takes + song + captions + effects |
| Every clip | all takes, original quality |
| Storyboard animatic | vertical 9:16 MP4 rendered on the device (WebM in browsers without MP4 recording) |
| Project backup | `.reashoota.json` with all media, which re-opens with **Import** |

PDFs come from a small built-in writer (`src/pdf.js`), so they generate offline with no libraries. The built-in fonts only cover Latin text, so other scripts show as `?` in PDFs. Text and Markdown exports keep everything.

## Offline / on location

- Every edit saves straight to IndexedDB on the phone: shots, completed status, notes, checklist, and camera and countdown settings. A service worker caches the app itself. Reading a shot list never needs a connection.
- **MAKE AVAILABLE OFFLINE** does three things. It asks the browser for persistent storage, re-caches the whole app, and builds thumbnails for every frame. The project then shows *Offline ready*.
- The open project, tab and scroll position are restored after a refresh, a crash or the app being closed. Pending saves are flushed when the app goes to the background.

## Projects & backup

- **Projects screen:** continue, duplicate, download (backup file), share (full pack PDF), delete. Media is shared between duplicates and cleaned up only when no project uses it.
- **New idea / New ideas for unshot:** regenerates a shot's idea without touching its completed status, notes or frame. Bulk regeneration skips completed shots. **Undo idea** restores earlier versions (the last 5 are kept).
- **Account backup:** once signed in, each saved project goes into a queue on the phone. The queue is pushed to the backend as a full bundle whenever there is signal, and the phone copy is always kept. The backend contract is in `src/cloud.js`: `GET /projects`, `GET /projects/:id`, `PUT /projects/:id` with a Bearer token. No backend ships with this repo.

## Develop

```sh
npm start          # serve the source at http://localhost:5173
npm run build      # deployable dist/ (Netlify runs this automatically)
npm run preview    # build, then serve dist/
npm test           # unit tests (node --test)
node scripts/smoke.mjs                 # end-to-end on an emulated iPhone (needs Playwright + Chromium)
SMOKE_ROOT=dist node scripts/smoke.mjs # same, against the build
npm run icons      # re-render PNG icons from icons/icon.svg (needs Playwright)
```

The build copies the app as-is (there is nothing to compile). It stamps the service worker cache version with a hash of the app files, so phones pick up each deploy automatically. It also fails if `sw.js` would leave a source file uncached, because the app would then break offline.

| File | Role |
| --- | --- |
| `src/project.js` | data model, duplicate, safe regeneration, demo project |
| `src/sections.js` | project → document blocks → text / Markdown |
| `src/pdf.js`, `src/pdf-packs.js` | PDF writer and layouts (document, storyboard grid, concept deck) |
| `src/images.js`, `src/video.js` | canvas shot cards / storyboard sheet / moodboard; 9:16 animatic |
| `src/exports.js` | export catalogue → `File`s |
| `src/share.js` | save to phone / share / download / copy |
| `src/store.js`, `src/offline.js`, `sw.js` | IndexedDB, offline mode, session restore, app-shell cache |
| `src/backup.js`, `src/cloud.js` | portable bundle and account sync queue |
| `src/echo/lexicon.js`, `src/echo/engine.js` | Young-D-Guide association library and engine: moments, six directions, weirdness, spin, motif world, idea → shot |
| `src/timeline.js` | slot timing, templates, beat snapping, BPM detection, caption timing, auto-fill (pure, unit-tested) |
| `src/render.js` | timeline player and final video render |
| `src/audio.js`, `src/camera.js`, `src/captions.js` | song decode/analysis, in-app camera, caption styles |
| `fonts/` | bundled Latin subsets (SIL Open Font License) so captions and UI work offline |
| `src/app.js` | UI |
