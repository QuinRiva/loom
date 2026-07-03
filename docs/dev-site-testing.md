# Dev-site testing runbook (scratch instance for agents)

How to stand up an isolated T3 Code web instance for live UI verification without
touching the real cockpit server/state (`13900`, `~/.t3/cockpit`).

1. **Server** — scratch home + dev URL:

   ```sh
   T3CODE_HOME=/tmp/<scratch> T3CODE_PORT=13911 \
   VITE_DEV_SERVER_URL=http://localhost:5734 T3CODE_NO_BROWSER=1 \
   node apps/server/src/bin.ts
   ```

2. **Web** — matching dev/proxy env and host binding:

   ```sh
   VITE_DEV_SERVER_URL=http://localhost:5734 \
   VITE_HTTP_URL=http://localhost:13911 VITE_WS_URL=ws://localhost:13911 \
   vp dev --port 5734 --host
   ```

3. **Auth** — open the pairing URL printed by the server; if the hash token does
   not auto-fill, paste it manually.

Gotchas:

- Without `VITE_DEV_SERVER_URL` set on **both** sides, browser auth may consume
  the one-time pairing token yet still fail, because client requests are treated
  as cross-origin / credentialless.
- Never point a scratch web instance at the live cockpit server unless that is
  explicitly the intent.
- Clean up the scratch processes and `/tmp/<scratch>` state when done.
