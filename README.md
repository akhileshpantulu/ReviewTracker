# Hotel Review Rankings

A single-file dashboard that ranks Marriott and IHG hotels on verified post-stay
guest review scores, within their own chain and brand.

**Live site:** https://akhileshpantulu.github.io/ReviewTracker/

## How it's hosted

GitHub Pages serves the contents of [`docs/`](docs/) from the `main` branch.
There is no build step — the dashboard is one self-contained HTML file that pulls
its data at runtime in the browser.

| Path | Purpose |
| --- | --- |
| `docs/index.html` | The entire dashboard (markup, CSS, JS in one file) |
| `docs/.nojekyll` | Tells Pages to serve files as-is instead of running Jekyll |
| `.github/workflows/deploy-pages.yml` | Publishes `docs/` on every push to `main` |

`docs/index.html` must keep that name and location: `index.html` is what makes
the bare `/ReviewTracker/` URL resolve, and `docs/` is the directory Pages
publishes.

## Updating the dashboard

Commit a new version of `docs/index.html` to `main`. The deploy workflow runs
automatically and the live site updates in a minute or two. Version history is
in the git log, so there's no need for `v4`/`v5`-style filenames.

To publish without a content change (for example after changing Pages settings),
run the **Deploy to GitHub Pages** workflow manually from the Actions tab.

To preview locally, open `docs/index.html` in a browser, or serve the folder so
the page runs from an `http://` origin rather than `file://`:

```sh
python3 -m http.server 8000 --directory docs
# then visit http://localhost:8000
```

## Review watch (email on new reviews)

[`review-watch.yml`](.github/workflows/review-watch.yml) polls the Bazaarvoice
API hourly for **Moxy Paris La Villette** and opens a GitHub issue whenever the
hotel's review count changes — up or down. GitHub emails the issue through
your repo watch notifications; there is no mail server or account involved.
One caveat: if you ever **Unwatch** this repository, the emails stop silently
while the issues keep being filed.

- New reviews: the issue includes each review's rating, title, text, and date
  (up to 5), plus the updated average.
- Count decreases (moderation/removals) are reported too.
- The last-seen count lives in `.state/review-watch.json`, committed back by
  the workflow, so restarts and re-runs don't re-notify.
- First run resolves the hotel's product ID from the catalog by name, caches
  it in the state file, and opens a "watch started" issue to confirm the email
  path works.

The cron only fires once this workflow is on the default branch. To test it
immediately, run it from the Actions tab (**Review watch** → *Run workflow*).
To watch a different hotel, edit `HOTEL_LABEL`/`HOTEL_TOKENS` at the top of
[`scripts/review-watch.mjs`](scripts/review-watch.mjs) and delete
`.state/review-watch.json` so the ID re-resolves.

Note: GitHub pauses scheduled workflows in repositories with no activity for
60 days; it emails a warning first, and re-enabling is one click on the
Actions tab.

## Data source

The page calls the Bazaarvoice guest-review API directly from the browser:

- `api.bazaarvoice.com/data/products.json` — hotel catalog, refreshed monthly
- `api.bazaarvoice.com/data/reviews.json` — per-hotel review history, on demand

The catalog is cached in `localStorage` for 30 days, so a first load is slow and
subsequent loads are fast. Selected hotels and comp sets also persist in
`localStorage`, which means they are per-browser and not shared between viewers.

Hotels with no new review in 24+ months are treated as inactive and excluded,
which drops rebranded and closed properties.

### Note on the API passkeys

`docs/index.html` contains the Marriott and IHG Bazaarvoice display passkeys in
plain text. They are read-only keys, and they are already public — Marriott's and
IHG's own websites ship them to every visitor. But this repository is public, so
they are also discoverable here. Two consequences worth knowing:

- If either chain rotates its passkey, the dashboard's catalog sync breaks until
  the new key is committed.
- Because the requests come from each visitor's own browser, API usage is spread
  across viewers rather than attributed to one server.
