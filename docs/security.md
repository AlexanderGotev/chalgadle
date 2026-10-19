# Security

This is the hardening log for chalgadle. Every measure follows the same structure:

- **Risk**: what could go wrong without it.
- **Change**: what I configured.
- **Verified**: how I checked that it actually works.

Sensitive values (IP addresses, resource IDs, tokens) are left out on purpose.

## Contents

1. [Network: hide the origin and only accept Cloudflare](#1-network-hide-the-origin-and-only-accept-cloudflare)
2. [SSH: no public port](#2-ssh-no-public-port)
3. [Admin panel](#admin-panel)
4. [Edge rules: rate limiting and hotlink protection](#4-edge-rules-rate-limiting-and-hotlink-protection)
5. [TLS and security headers](#5-tls-and-security-headers)
6. [Application security](#6-application-security)
7. [Process sandboxing with systemd](#7-process-sandboxing-with-systemd)
8. [Host: updates, firewall, metadata service](#8-host-updates-firewall-metadata-service)
9. [Account and data](#9-account-and-data)
10. [Deliberately not done](#10-deliberately-not-done)

---

## 1. Network: hide the origin and only accept Cloudflare

**Risk.** The site's DNS record pointed straight at the EC2 instance, so anyone could find the server's IP and attack it directly, bypassing anything Cloudflare does.

**Change.**
- Turned on the Cloudflare proxy for the A record. Visitors now resolve to Cloudflare IPs. SSL mode is **Full (strict)**: Cloudflare connects to the origin over HTTPS and validates its certificate.
- The DDNS script that updates the record when the instance's IP changes used to send `"proxied": false`, which would have silently turned the proxy off at the first IP change. It now sends `"proxied": true` ([`config/ddns.example.sh`](../config/ddns.example.sh)).
- Hiding the IP alone is not enough, because the old IP was public before. So I created an AWS **managed prefix list** with Cloudflare's 15 published IPv4 ranges and changed the Security Group so ports 80 and 443 accept traffic **only from that list**.

Inbound rules after the change:

| Port | Protocol | Source | Purpose |
|---|---|---|---|
| 80 | TCP | Cloudflare prefix list | HTTP → redirected to HTTPS by Caddy |
| 443 | TCP | Cloudflare prefix list | HTTPS |
| — | ICMP | 0.0.0.0/0 | Echo, kept on purpose for a separate networking experiment |

No SSH rule. See section 2.

**Verified.**
```text
> nslookup chalgadle.com            → Cloudflare addresses (104.x / 172.67.x)
> curl -I https://chalgadle.com     → server: cloudflare, cf-ray: …, via Caddy
> curl -k --max-time 10 https://<origin-ip>
000                                  → timeout: the origin no longer answers directly
```

## 2. SSH: no public port

**Risk.** Port 22 was open to `0.0.0.0/0`. Key-only authentication was already on, so brute force could not succeed, but an open SSH port is still exposed to any future OpenSSH vulnerability (e.g. *regreSSHion*, CVE-2024-6387) and to constant scanning. My laptop moves between networks, so I could not simply allow a single home IP.

**Change.**
- Installed **Tailscale** on the server and my laptops. SSH now goes to the server's private Tailscale address, and the SSH rule was **removed from the Security Group**.
- `ufw allow in on tailscale0`. The ufw rule for port 22 stays on purpose, so recovery is a single Security Group change in the AWS console if Tailscale ever breaks.
- Disabled direct root login: `PermitRootLogin no` in `/etc/ssh/sshd_config.d/00-hardening.conf`. The `00-` prefix matters because `sshd` uses the first value it reads.
- Already in place before this work: `PasswordAuthentication no` and fail2ban.

**Verified.**
```text
$ sudo sshd -T | grep -E 'permitrootlogin|passwordauthentication'
permitrootlogin no
passwordauthentication no

> ssh ubuntu@chalgadle.com     → times out (port closed to the internet)
> ssh ubuntu@chalgadle         → connects over Tailscale
```

Why Tailscale and not AWS Systems Manager: see [decisions.md](decisions.md#ssh-access-tailscale-instead-of-ssm).

<a id="admin-panel"></a>
## 3. Admin panel

**Risk.** The admin panel can add, edit and hide songs and replace cover images. It has no login of its own because it was designed to be used only on the machine itself. The site and the admin panel are the **same Node.js process**, so Caddy forwards both to it.

**Change.** Two independent layers:

1. **Caddy** answers `404` for `/admin*`, `/api/admin/*` and `/api/scan*` before anything reaches Node ([`config/Caddyfile`](../config/Caddyfile)).
2. **The application** allows these paths only for requests that come from the loopback address **and have no `X-Forwarded-For` header**.

The second condition was the important lesson. My first version only checked `remoteAddress === 127.0.0.1`. Behind a reverse proxy on the same machine, **every** request comes from `127.0.0.1`, so that check would have let the whole internet in if the Caddy rule were ever lost. Caddy always adds `X-Forwarded-For`, while an SSH tunnel connects to Node directly without it:

```js
function isLocal(req) {
  if (req.headers['x-forwarded-for'] || req.headers['forwarded']) return false;
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
```

I reach the panel with an SSH tunnel over Tailscale:

```text
ssh -L 3000:localhost:3000 ubuntu@chalgadle   →   http://localhost:3000/admin
```

**Verified.**
```text
# From outside: every variant is stopped at Caddy
curl -I https://chalgadle.com/admin   /Admin   /%61dmin   //admin   /admin/    → 404

# On the server, straight to Node: tunnel vs. "came through the proxy"
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/admin
200
$ curl -s -o /dev/null -w "%{http_code}" -H "X-Forwarded-For: 1.2.3.4" http://127.0.0.1:3000/admin
403
```

The second test simulates the Caddy rule being gone: the application still refuses.

## 4. Edge rules: rate limiting and hotlink protection

### Rate limiting

**Risk.** A script could hammer the API, either to scrape the song list or simply to load the server.

**Change.** Cloudflare rate limiting rule `api-limit`: URI path starts with `/api/`, more than **30 requests per 10 seconds per IP** → block for 10 seconds. A normal round makes 2–6 API calls, so real players never hit it, even several behind one shared IP.

**Verified.**
```text
> for /L %i in (1,1,40) do @curl -s -o NUL -w "%{http_code} " https://chalgadle.com/api/genres
200 200 200 … 200 429 429 429 …
```

### Hotlink protection

**Risk.** Another website could embed the audio files directly. Its visitors would stream from my server, and I would pay for the bandwidth.

**Change.** Cloudflare custom rule `audio-hotlink`:

```text
(starts_with(http.request.uri.path, "/audio/")
 and not starts_with(http.referer, "https://chalgadle.com/"))  →  Block
```

I put this rule at the Cloudflare edge rather than in Caddy, so it still applies if the audio is ever cached by Cloudflare.

**Verified.**
```text
> curl -s -o NUL -w "%{http_code}" https://chalgadle.com/audio/1961
403
> curl -s -o NUL -w "%{http_code}" -e https://chalgadle.com/ https://chalgadle.com/audio/1961
200
```

The `Referer` header can be forged, so this stops other sites and copied links, not a determined individual. The real fix for "people can download the songs" was to keep only 16-second clips on the server (see [decisions.md](decisions.md#cut-songs-down-to-clips)).

## 5. TLS and security headers

**Risk.** Without these headers, browsers fall back to permissive defaults: the page can be framed (clickjacking), injected scripts would run, and the first visit could be downgraded to HTTP.

**Change.** In the Caddyfile:

| Header | Value / effect |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000`: HTTPS only for a year |
| `Content-Security-Policy` | scripts only from the site itself; styles from self and Google Fonts; fonts from Google Fonts; images, media, connections from self; `frame-ancestors 'none'` |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | camera, microphone, geolocation disabled |
| `Server`, `Via`, `X-Powered-By` | removed |

I rolled out the CSP in **`Content-Security-Policy-Report-Only`** mode first. The browser console showed only violations for inline `style` attributes that the game sets from JavaScript. I allowed `'unsafe-inline'` for **styles only**, since inline styles carry far less risk than inline scripts, which remain blocked. Then I switched the policy to enforcing.

TLS: Caddy obtains and renews a Let's Encrypt certificate automatically. Cloudflare runs in Full (strict) mode. "Always Use HTTPS" stays off in Cloudflare, because Caddy already redirects HTTP to HTTPS and the HTTP-01 renewal challenge has to reach it over plain HTTP.

**Verified.**
```text
> curl -s -D - -o NUL https://chalgadle.com
content-security-policy: default-src 'self'; script-src 'self'; …
strict-transport-security: max-age=31536000
x-content-type-options: nosniff
x-frame-options: DENY
…                                   (no via / x-powered-by)
```
I also played full rounds with the console open: no `Refused to …` errors.

## 6. Application security

**Before publishing the code, I reviewed it for the usual web vulnerabilities.**

| Concern | Status |
|---|---|
| **SQL injection** | All queries are prepared statements with bound parameters |
| **XSS** | Song names come from ID3 tags, so they are untrusted. Every value inserted into HTML goes through an escaping function |
| **Path traversal** | Static files are checked to stay inside `public/`; audio files are resolved inside `music/`; covers accept only `/covers/<digits>.jpg` |
| **Large request bodies** | Bodies are capped at 1 MB; uploaded covers must start with the JPEG signature |
| **Methods** | From outside only `GET` is allowed, plus exactly one `POST` endpoint (`/api/guess`) |
| **Dependencies** | None. Only Node.js built-in modules |

**Path traversal, verified** directly against Node (bypassing Cloudflare and Caddy, which normalise some of these paths themselves):

```text
/../server.js                    404
/%2e%2e/server.js                404
/..%2fserver.js                  403
/%2e%2e%2fdata/                  403
/audio/..%2f..%2fserver.js       404
/audio/%2e%2e%2f%2e%2e%2fserver.js  404
```

### Keeping the answer on the server

**Risk.** Originally `/api/random` returned `{ id, artist, title }` for the round. Opening the browser's Network tab revealed the answer before the first note. This was not a risk to the server, but it made cheating trivial.

**Change.**
- `/api/random` returns only a random 128-bit **round code** and the clip start.
- Audio is fetched by round code (`/audio/r/<code>`). Fetching by song ID (`/audio/<id>`) is now allowed only locally, for the admin panel.
- Guesses go to `POST /api/guess`. The server allows **5 attempts per round** (one per stage), so a round cannot be brute-forced against the whole song list. It reveals the song only after a correct guess or the last attempt.
- Rounds live in memory with a TTL and a size cap, so creating rounds cannot exhaust memory.

**Verified** with an automated browser test against a local copy of the app: in a lost round and a won round, no `/api/random` response contained an artist or title, and the sixth guess on a finished round only returned the already revealed answer.

**Accepted limit.** The audio itself must reach the browser, so a player can still identify a clip with an app like Shazam. That is true of every game of this kind.

## 7. Process sandboxing with systemd

**Risk.** The app ran as the `ubuntu` user, which on EC2 has passwordless `sudo`. A remote-code-execution bug in the app would have meant root on the machine, along with access to the SSH keys and the Cloudflare API token in the home directory.

**Change.** A drop-in at `/etc/systemd/system/chalgadle.service.d/hardening.conf` ([`config/chalgadle-hardening.conf`](../config/chalgadle-hardening.conf)):

| Directive | Effect |
|---|---|
| `NoNewPrivileges=true` | `sudo` and setuid binaries cannot raise privileges from inside the service |
| `ProtectSystem=strict`, `ProtectHome=read-only` | Whole filesystem read-only for the service… |
| `ReadWritePaths=…/data …/music` | …except the database/covers folder and the music folder |
| `InaccessiblePaths=~/.ssh ~/ddns.sh` | The process cannot even see the SSH keys or the script holding the Cloudflare token |
| `PrivateTmp`, `PrivateDevices`, `ProtectKernel*`, `ProtectControlGroups`, `RestrictSUIDSGID`, `LockPersonality` | Isolated `/tmp`, no hardware devices, no kernel tuning or module loading |

I chose this over a dedicated system user because it gives most of the same protection without moving the project out of the home directory (see [decisions.md](decisions.md#process-isolation-systemd-sandbox-instead-of-a-new-user)).

**Verified.**
```text
$ sudo systemd-analyze security chalgadle | tail -1
before:  Overall exposure level for chalgadle.service: 9.2 UNSAFE 😨
after:   Overall exposure level for chalgadle.service: 6.9 MEDIUM 😐
```
I then played rounds and edited songs and covers in the admin panel, to confirm the app can still write where it needs to.

## 8. Host: updates, firewall, metadata service

**Automatic security updates.** `unattended-upgrades` installs security updates daily. [`config/52unattended-upgrades-local`](../config/52unattended-upgrades-local) enables an automatic reboot at a fixed early-morning time when a kernel update requires one. The app is an enabled systemd service, so it comes back up by itself.

**ufw.** Default deny for incoming traffic. Allowed: 80, 443, 22 (see section 2) and the Tailscale interface. This is a second line behind the Security Group in case the cloud configuration is ever wrong.

**IMDSv2 required.** The EC2 metadata service (`169.254.169.254`) can hand out temporary credentials. With IMDSv1, a server-side request forgery bug could read them with a plain `GET`. IMDSv2 requires a session token obtained with a `PUT`, which that kind of bug cannot do.

**Verified:** `sudo ufw status`, `cat /etc/apt/apt.conf.d/20auto-upgrades` (both values `"1"`), `apt-config dump | grep Automatic-Reboot`, and the instance metadata options in the EC2 console show *IMDSv2: Required*.

## 9. Account and data

- **AWS root account protected with MFA.**
- **Backups:** `config/backup.sh` runs nightly from cron and uses SQLite's online `.backup` command, which is safe while the app is writing, unlike copying the file. It keeps 14 days. I copy the backups to my laptop, because a backup that lives only on the same machine does not survive losing the machine. Automating that copy is on the roadmap.
- **Secrets stay out of the repository:** the published `ddns.example.sh` has placeholders, and `.gitignore` excludes the database, music, covers and logs.

## 10. Deliberately not done

Some measures I considered and decided against for now. The reasoning is in [decisions.md](decisions.md):

- **AWS GuardDuty:** paid after the trial, and of limited value for a single instance with no IAM roles.
- **A separate IAM user for daily console work:** I currently use the root account with MFA. Noted as a trade-off.
- **Uptime monitoring and automated off-site backups:** on the [roadmap](roadmap.md).
