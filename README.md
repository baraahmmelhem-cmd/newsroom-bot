# Mr_Amwal hourly news bot (runs on GitHub, your PC can be off)

## Setup (10 minutes)
1. Create a **private** repo on GitHub and upload everything in this folder (keep the `.github` folder).
2. Repo > Settings > Secrets and variables > Actions > New repository secret. Add:
   - `CRYPTOPANIC_API_KEY`  - from your CryptoPanic developer settings
   - `GEMINI_API_KEY`       - FREE key from aistudio.google.com (writes the Arabic text)
   - `NEWSROOM_API_URL`     - the endpoint that publishes a news item on mr-amwal.com
   - `NEWSROOM_API_TOKEN`   - the token/key that endpoint accepts
3. Actions tab > "Hourly Mr_Amwal news" > Run workflow (test once), then it runs every hour at :35 UTC.

## Must be checked before it works
- `publish()` in `scripts/run.py` uses placeholder field names. Ask whoever built the site for the real
  endpoint, auth method and field names, then edit that one function.
- CryptoPanic API URL/params can differ by plan; set `CRYPTOPANIC_URL` if yours is different.
- Not tested end to end: the build sandbox cannot reach mr-amwal.com or CryptoPanic.
- GitHub may delay scheduled runs by a few minutes, and pauses them if the repo has no activity for 60 days.

WhatsApp messages cannot be sent from GitHub (WhatsApp Web needs your logged-in Chrome); those stay on your PC.
