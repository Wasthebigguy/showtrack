# ShowTrack 📺🎬

A personal TV show and movie tracker in the spirit of TV Time. Search any show or movie, check off episodes, keep a list of movies to watch, see when new episodes and movies come out, and sync it all across your devices.

It is plain HTML, CSS and JavaScript with no build step or server, so it runs for free on **GitHub Pages**. Shows need no key; movies need a free TMDB key.

## Features

- **Search** any TV show (powered by [TVmaze](https://www.tvmaze.com))
- **Watchlist**: the next episode to watch for every show, with a one-tap ✓ (and Undo)
- **Upcoming**: a calendar of new episodes from your shows, in your local time, plus what aired this past week
- **Show pages** with seasons, episode check-offs, *Mark all* per season, episode summaries and the next air date
- Checking an episode offers to mark all the earlier episodes too
- **Statuses**: Watching, Plan to watch, Completed (set automatically when you finish an ended show) and Stopped
- **Stats**: shows, episodes watched, total time watched and episodes this week
- Checks your shows for new episodes automatically every 12 hours (or tap ⟳)
- **Installable** on your phone's home screen, and opens offline
- **Movies**: a *Want to watch* list and a *Watched* list, with your own 1–5 star rating; upcoming releases show in the Upcoming tab (powered by [TMDB](https://www.themoviedb.org), free key)
- **Auto sync** between your phone, laptop and other devices, using a secret gist in your GitHub account
- **Backup / restore** your library as a JSON file

## Put it on GitHub Pages

1. Create a new repository on GitHub, for example `showtrack` (public).
2. Upload all the files in this folder to the root of the repo. You can use **Add file → Upload files** and drag them in.
3. Go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, then select the `main` branch and the `/ (root)` folder. Click **Save**.
4. After about a minute your app is live at `https://<your-username>.github.io/showtrack/`.

To get it on your phone, open that link and use **Add to Home Screen** (Safari share menu, or Chrome's ⋮ menu).

## Turn on movies (one time)

1. Create a free account at [themoviedb.org](https://www.themoviedb.org/signup).
2. Open [Settings → API](https://www.themoviedb.org/settings/api) and request a key (Developer, personal use).
3. Copy the **API Key** and paste it in the app under **Movies** or **Settings**. With sync on, the key reaches your other devices automatically.

## Turn on sync (one time per device)

1. In the app, open **Settings** (gear icon) and follow the link to create a GitHub token. It is pre-filled with only the **gist** permission.
2. Choose an expiration (for example *No expiration*), generate it, copy it and paste it into the app.
3. On each other device, paste the same token. The app finds your existing data automatically.

**How it works:** your shows, movies and watch history are saved in one secret gist called `showtrack-data.json` in your GitHub account. Each change uploads a few seconds after you make it. Every device checks for changes when you open the app and every 2 minutes while it is open. Each item remembers when it was last changed, and the newest change wins, so edits made on two devices are combined instead of overwritten.

**Privacy:** the token stays on the device where you paste it and is never uploaded. A secret gist isn't listed anywhere, but anyone who has its exact link can open it. It only contains your watch list.

## Where your data lives

Everything is also saved in **your browser** (localStorage), so the app works offline and opens instantly. Without sync, each device has its own library; use **Settings → Download backup / Restore backup** to move it.

## Run it locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Files

| File | What it is |
|---|---|
| `index.html` | Page shell and navigation |
| `styles.css` | All styling (dark theme, mobile-first) |
| `app.js` | The whole app: TVmaze and TMDB APIs, storage, sync, views |
| `sw.js` | Service worker that caches the app for offline use |
| `manifest.json`, `icon*` | Home-screen app icon and settings |

## Credits

Show and episode data comes from the [TVmaze API](https://www.tvmaze.com/api), licensed CC BY-SA. Movie data comes from [TMDB](https://www.themoviedb.org). This product uses the TMDB API but is not endorsed or certified by TMDB.
