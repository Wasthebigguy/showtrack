# ShowTrack 📺

A personal TV show tracker in the spirit of TV Time. You can search any show, add it to your library and check off episodes as you watch them. It also shows when new episodes are coming out.

It is plain HTML, CSS and JavaScript with no build step, server or API key, so it runs for free on **GitHub Pages**.

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
- **Backup / restore** your library as a JSON file

## Put it on GitHub Pages

1. Create a new repository on GitHub, for example `showtrack` (public).
2. Upload all the files in this folder to the root of the repo. You can use **Add file → Upload files** and drag them in.
3. Go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, then select the `main` branch and the `/ (root)` folder. Click **Save**.
4. After about a minute your app is live at `https://<your-username>.github.io/showtrack/`.

To get it on your phone, open that link and use **Add to Home Screen** (Safari share menu, or Chrome's ⋮ menu).

## Where your data lives

Your library and watch history are saved in **your browser** (localStorage). They are not stored on GitHub, and no account is needed. This means:

- Each browser or device has its own library. To move it, use **My Shows → Download backup**, then **Restore backup** on the other device.
- Clearing your browser's site data erases the library, so download a backup now and then.

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
| `app.js` | The whole app: TVmaze API, storage, views |
| `sw.js` | Service worker that caches the app for offline use |
| `manifest.json`, `icon*` | Home-screen app icon and settings |

## Credits

Show and episode data comes from the [TVmaze API](https://www.tvmaze.com/api), licensed CC BY-SA.
