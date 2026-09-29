# ReaShoota

A mobile-first creative director for music video shoots. It's built for an iPhone on location: plan the shots, shoot with the phone in your hand, and save everything to the phone. It keeps working with no signal.

It is a static PWA. There is no build step and nothing to install at runtime, so it can be deployed to any static host (Netlify config is included).

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
npm start          # serve at http://localhost:5173
npm test           # unit tests (node --test)
node scripts/smoke.mjs   # end-to-end on an emulated iPhone (needs Playwright + Chromium)
npm run icons      # re-render PNG icons from icons/icon.svg (needs Playwright)
```

After changing app files, bump `VERSION` in `sw.js` so installed copies clean up their old cache.

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
| `src/app.js` | UI |
