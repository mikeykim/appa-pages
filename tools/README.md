# tools

`reddit_publish.mjs` — a personal, zero-dependency Node script that posts the developer's own blog articles (Markdown files with front matter) to the developer's own Reddit account via the official OAuth API.

- Scopes: `identity`, `submit`, `read`
- Volume: at most one post per week, triggered manually or by a weekly scheduler; no reading of other users' data, no scraping, no automated comments or votes
- Auth: authorization-code flow with a local callback; only a refresh token is stored locally
- Content: informational guides for new dads (deadlines for newborn paperwork, insurance and leave) with a disclosure paragraph; the app it relates to is free with no ads

`lib/blogmd.mjs` — front-matter parsing and Markdown helpers shared with the WordPress publisher.
