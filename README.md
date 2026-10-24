# Narrate

A personal audiobook maker. Paste text or import an EPUB, PDF, TXT, Markdown or HTML file, and it turns the book into an MP3 using Kokoro, a free open-source voice model that runs on your own device. Playback works with the iPhone screen locked, with lock-screen controls, chapters, speed, a sleep timer and a saved position.

No accounts, no API keys, no per-book cost. Nothing you import leaves your device.

## Put it online (GitHub Pages, about 5 minutes)

It needs to be served over HTTPS; opening `index.html` straight from your files won't work.

1. Sign in at github.com and create a new **public** repository called `narrate`.
2. On the empty repo page, click **uploading an existing file**, drag in everything inside this folder (including the `icons` folder), and click **Commit changes**.
3. Go to **Settings → Pages**. Under "Build and deployment", set Source to **Deploy from a branch**, branch **main**, folder **/ (root)**, and save.
4. After a minute your app is live at `https://YOUR-USERNAME.github.io/narrate/`.

## Set it up on your iPhone

1. Open the link in **Safari**.
2. Tap Share → **Add to Home Screen**. If you see an **Open as Web App** switch, turn it **off**.

That switch matters. iPhone home-screen web apps have a long-standing habit of stopping audio when the screen locks; the same page running as a normal Safari tab keeps playing. With the switch off, the icon opens Narrate in Safari. If the app ever detects it's running in web-app mode, it shows a warning at the top of the library.

## Making a book

**Fastest: generate on a laptop.** Open the same link in Chrome on your laptop, add the book, and leave the tab open. Chrome uses the graphics card. When it's done, open the book, tap **More → Export MP3**, AirDrop the file to your iPhone, then in Narrate on the phone tap **Add a book** and pick the MP3. Chapters and the on-screen text come with it.

**Or generate on the phone.** It works but is much slower than on a laptop, and it pauses whenever the screen locks or you leave Safari (Narrate keeps the screen awake while it's generating). It picks up where it stopped when you tap **Resume**. Best for articles and short books.

You can start listening as soon as the first passage is ready; playback rolls forward as more is generated.

The first time you generate or preview a voice, the model downloads once (about 90 MB on a phone, about 330 MB on a laptop) and is cached for offline use.

## Sizes and time

- Audio is about 22 MB per hour at Standard quality, so an 8-hour book is roughly 175 MB.
- Generation speed depends entirely on the device. The app shows the real speed and time remaining once it starts.

## Good to know

- Safari can clear website storage for sites you haven't opened in a while. Keep exported MP3s of books you care about; re-importing restores everything.
- Scanned PDFs (images of pages) have no text to read. Run OCR first.
- Uncheck front matter, notes and indexes on the review screen so they aren't read aloud.
- Voices are English only (US and UK). Heart and Bella sound the most natural; the male voices are noticeably weaker in this model.

## Files

- `index.html`: layout and styles
- `app.js`: library, import flow, generation manager, player and lock-screen controls
- `worker.js`: runs the voice model off the main thread and encodes MP3
- `textproc.js`: text cleanup, chapter detection, sentence splitting, pacing pauses
- `importers.js`: EPUB, PDF, Markdown and HTML import
- `audio.js`: MP3 encoding and the ID3 tag that carries chapters and text inside exports
- `sw.js`: offline caching
