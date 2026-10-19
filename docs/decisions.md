# Design decisions

Short records of the choices that shaped the project: the options I had, what I picked, and what it costs.

---

## SSH access: Tailscale instead of SSM

**Context.** I wanted port 22 closed to the internet without losing SSH. I need it to deploy files with `scp` and to tunnel into the admin panel. My laptop changes networks, so allowing one IP was not an option.

**Options.**
1. Keep SSH open with keys only. Low risk, but still exposed to future OpenSSH vulnerabilities.
2. **AWS Systems Manager Session Manager.** Supports shell sessions and port forwarding with no inbound port. It needs an IAM instance role, an IAM user with access keys on each laptop, the AWS CLI and the Session Manager plugin.
3. **Tailscale.** A WireGuard-based private network. Install it on the server and the laptops, then SSH to a private address.

**Decision.** Tailscale. It gives the same result as SSM, no inbound port, with far less setup and no AWS credentials stored on my laptops. My existing workflow (`ssh`, `scp`, `ssh -L`) works unchanged. It also keeps working when the domain is proxied by Cloudflare, which only forwards web traffic, and when the instance's public IP changes.

**Trade-offs.** One more external service in the access path. The fallback is a single Security Group rule I can re-add from the AWS console, which is why the ufw rule for port 22 stays in place. The node key expiry is disabled for the server so it does not drop off the network after six months.

---

## Only accept web traffic from Cloudflare: a managed prefix list

**Context.** Turning on the Cloudflare proxy hides the IP from DNS, but the IP had been public before. Without a firewall change, anyone who knew it could still bypass Cloudflare, along with its rate limiting and WAF rules.

**Options.** 30 individual Security Group rules (15 ranges × 2 ports), a managed prefix list, or a script that keeps the rules in sync.

**Decision.** One **managed prefix list** with the 15 ranges, referenced by two rules (HTTP and HTTPS). It is easy to read, free, and updating Cloudflare's ranges means editing one list.

**Trade-offs.** Each rule that references the list counts as *max-entries* rules against the Security Group quota (20 + 20 of 60). If Cloudflare publishes new ranges, I have to add them by hand. Let's Encrypt renewals are not affected, because validation also goes through Cloudflare.

---

## Process isolation: systemd sandbox instead of a new user

**Context.** The app ran as `ubuntu`, which has passwordless `sudo`.

**Options.**
1. A dedicated system user, with the project moved to `/opt`. This is the cleanest separation, but it changes the deployment paths, file ownership and the backup script.
2. **systemd sandboxing directives** on the existing service.

**Decision.** The systemd sandbox. `NoNewPrivileges` closes the path to `sudo`, `ProtectSystem=strict` plus `ReadWritePaths` limits writes to two folders, and `InaccessiblePaths` hides the SSH keys and the Cloudflare token. `systemd-analyze security` went from 9.2 to 6.9 without touching the deployment.

**Trade-offs.** The process can still *read* the rest of the home directory. A dedicated user is still worth doing later. `MemoryDenyWriteExecute` cannot be used, because the V8 JavaScript engine needs to generate machine code at run time.

---

## Admin panel: localhost only, no login

**Context.** The admin panel is for one person. Building authentication (password storage, sessions, CSRF protection, brute-force protection) would add a lot of code that could itself contain bugs.

**Decision.** No login. The panel is not reachable from the internet at all: Caddy blocks it, the app refuses anything that came through the proxy, and I reach it through an SSH tunnel over Tailscale. Authentication is effectively my SSH key plus my Tailscale identity.

**Trade-off.** Only someone with shell access can administer the game. For a one-person project, that is the point.

---

## Cut songs down to clips

**Context.** The game plays at most 16 seconds per song, but the server stored and sent **full songs** (about 6.5 MB each, 24 GB in total). Anyone could download complete tracks from the Network tab, every round cost about 6.5 MB of AWS egress, and loading took several seconds.

**Decision.** After the clip-start analysis, `finalize_clips.js` cut every file to a **16.5-second clip** starting at the chosen point (ffmpeg, 128 kbps MP3) and reset each start to 0. Full-length originals are no longer kept on the server.

**Result.** A clip is about 260 KB instead of about 6.5 MB, so storage and egress per round dropped by over 20×, rounds load much faster, and only the part of a song that is played anyway is available to download.

**Trade-off.** It cannot be undone on the server. Changing a clip's start or length means re-cutting from the originals.

---

## Covers: download and serve locally, review by hand

**Context.** The result screen showed initials on a coloured square. I wanted real cover art.

**Decision.**
- `fetch_covers.js` searches **Deezer**, then **iTunes** (Bulgarian store first), then the artist's photo on Deezer. It searches in both Cyrillic and Latin script, because the APIs do not transliterate. It strips track numbers and "feat./вкл." from names, and accepts a result only when both artist and title match closely enough.
- Images are **downloaded to the server**, not linked. This keeps the strict CSP (`img-src 'self'`) intact, avoids depending on third-party URLs at run time, and lets Cloudflare cache them.
- Uncertain matches are listed in the admin panel for review: approve, reject, or upload a replacement.
- The cover is requested only on the result screen, so it cannot reveal the answer during a round.

---

## No npm dependencies

The server uses only Node.js built-ins: `http`, `fs`, `crypto` and `node:sqlite`. There is no `node_modules` to audit or update, and no exposure to compromised packages. The price is writing a small router and static file server by hand, which is also why I reviewed that part specifically for path traversal.

---

## Accepted risks (for now)

| Item | Why it is acceptable now | Plan |
|---|---|---|
| Root account for console work (with MFA) | Single-person account, MFA enabled, no access keys | Create an IAM user with MFA for daily use |
| No GuardDuty | Paid after the trial; little to detect on one instance without roles or keys | Revisit if the setup grows |
| ICMP open to the world | Needed for a separate experiment. It only reveals that a host is up, and web ports accept only Cloudflare | Restrict when the experiment ends |
| Clips can be identified with Shazam | The audio has to reach the browser in any game of this kind | None. Inherent to the genre |
