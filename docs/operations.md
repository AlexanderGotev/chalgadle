# Operations

How the service is deployed and kept running. Paths assume the default `ubuntu` user on an EC2 Ubuntu 24.04 instance, with the app in `/home/ubuntu/poznai-pesenta`.

## Deploying from scratch

### 1. Instance

- EC2 `t3.micro`, Ubuntu 24.04 LTS, a 2 GB swap file (the instance has about 1 GB RAM).
- Instance metadata: **IMDSv2 required**.
- Security Group: create a managed prefix list from <https://www.cloudflare.com/ips-v4>, then allow TCP 80 and 443 from that list only. No SSH rule (access goes through Tailscale, step 3).

### 2. Packages

```bash
sudo apt update && sudo apt install -y caddy ffmpeg sqlite3 fail2ban
# Node.js 22.13 or newer (node:sqlite), e.g. from NodeSource
```

### 3. Access

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                      # approve in the browser; disable key expiry for this node
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 22/tcp
sudo ufw allow in on tailscale0 && sudo ufw enable
echo "PermitRootLogin no" | sudo tee /etc/ssh/sshd_config.d/00-hardening.conf
sudo sshd -t && sudo systemctl restart ssh
```

### 4. App

```bash
git clone https://github.com/AlexanderGotev/chalgadle.git
cp -r chalgadle/app ~/poznai-pesenta
mkdir -p ~/poznai-pesenta/music/<Genre>      # put the MP3s here, one sub-folder per genre
```

No `npm install` is needed. There are no dependencies.

### 5. Services and configuration

| File in `config/` | Goes to |
|---|---|
| `chalgadle.service` | `/etc/systemd/system/chalgadle.service` |
| `chalgadle-hardening.conf` | `/etc/systemd/system/chalgadle.service.d/hardening.conf` |
| `Caddyfile` | `/etc/caddy/Caddyfile` |
| `52unattended-upgrades-local` | `/etc/apt/apt.conf.d/52unattended-upgrades-local` |
| `ddns.example.sh` | `~/ddns.sh`, after filling in the token and zone ID |
| `backup.sh` | `~/backup.sh` |

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now chalgadle
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

Crontab (`crontab -e`):

```cron
*/5 * * * * /home/ubuntu/ddns.sh   >> /home/ubuntu/ddns.log   2>&1
@reboot sleep 30 && /home/ubuntu/ddns.sh >> /home/ubuntu/ddns.log 2>&1
0 4 * * *   /home/ubuntu/backup.sh >> /home/ubuntu/backup.log 2>&1
```

### 6. Cloudflare

- DNS: A record for the domain, **proxied** (orange cloud).
- SSL/TLS: **Full (strict)**. "Always Use HTTPS" off, since Caddy redirects.
- Security rules: the `audio-hotlink` custom rule and the `api-limit` rate limiting rule ([security.md](security.md#4-edge-rules-rate-limiting-and-hotlink-protection)).

### 7. Content

1. Open the admin panel through the tunnel: `ssh -L 3000:localhost:3000 ubuntu@<tailscale-name>`, then `http://localhost:3000/admin`.
2. **Scan the folder**, review the list, add the songs.
3. **Find start points** for the new songs, then adjust any that need it in the editor.
4. Keep the originals somewhere else, then cut the songs to clips: `node finalize_clips.js` (run it with the service stopped).
5. Fetch covers: `node fetch_covers.js`, then review uncertain matches in the admin panel.

## Routine tasks

### Updating the code

```bash
# from the laptop, over Tailscale
scp server.js        ubuntu@<tailscale-name>:~/poznai-pesenta/
scp public/app.js    ubuntu@<tailscale-name>:~/poznai-pesenta/public/
# on the server
sudo systemctl restart chalgadle
```

Front-end files are read from disk on each request. Only `server.js`, `db.js` and `library.js` need a restart. Restarting clears in-progress rounds, and players are moved to a new song automatically.

### Adding songs

Copy MP3s into `music/<Genre>/`, then in the admin panel: scan → find start points → `node finalize_clips.js` → `node fetch_covers.js`. The last two only process songs that still need it.

### Long-running scripts

`fetch_covers.js` respects the Deezer and iTunes rate limits, so a full run over thousands of songs takes hours. Run it detached and in append mode. A re-run continues where the previous one stopped:

```bash
cd ~/poznai-pesenta && nohup node fetch_covers.js >> covers.log 2>&1 &
pgrep -af fetch_covers          # still running?
tail -f covers.log              # progress
```

### Backups

```bash
ls -la ~/backups                # one SQLite snapshot per day, 14 kept
# from the laptop
scp "ubuntu@<tailscale-name>:~/backups/library-*.db" .
```

To restore, stop the service, copy a snapshot over `data/library.db`, and start the service.

### Health checks

```bash
systemctl is-active chalgadle caddy
journalctl -u chalgadle -n 50 --no-pager
sudo systemd-analyze security chalgadle | tail -1
cat /var/run/reboot-required 2>/dev/null   # pending kernel update?
```

The app answers only `GET` (and `POST /api/guess`) from outside. An uptime monitor must therefore use `GET`: a `HEAD` request gets `403`.
