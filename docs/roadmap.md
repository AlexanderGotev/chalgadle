# Roadmap

## Done for the first beta (13–18 October 2026)

- [x] Game with genre filter, progressive clip stages, Cyrillic/Latin search
- [x] Automatic clip-start detection and an editor in the admin panel
- [x] Deployed on AWS EC2 behind Caddy and Cloudflare
- [x] Origin IP hidden; web traffic accepted only from Cloudflare
- [x] SSH moved off the internet to Tailscale; root login disabled
- [x] Admin panel protected at the proxy and in the application
- [x] Rate limiting, hotlink protection, security headers with enforced CSP
- [x] systemd sandbox (exposure 9.2 → 6.9), IMDSv2, automatic security updates
- [x] Answer kept on the server (round codes, 5 attempts per round)
- [x] Songs cut to 16-second clips
- [x] Cover art with automatic matching and manual review

## Next

### Operations
- [ ] **Uptime monitoring** with an external checker (must use `GET`, see [operations.md](operations.md#health-checks)).
- [ ] **Automated off-site backups.** Pull the nightly SQLite snapshots to another machine on a schedule, or push them to object storage.
- [ ] **Billing alert** for actual usage, once the account leaves the free-plan credits.

### Security
- [ ] **IAM user with MFA** for daily console work; keep root for emergencies only.
- [ ] **Further systemd hardening:** `SystemCallFilter=@system-service`, `RestrictAddressFamilies`, `CapabilityBoundingSet=`. `MemoryDenyWriteExecute` is not possible because V8 needs JIT.
- [ ] **Dedicated system user** for the app, so it cannot read the rest of the home directory either.
- [ ] **Restrict ICMP** once the separate experiment that needs it is finished.
- [ ] Answer `HEAD` requests like `GET`, so standard monitoring tools work without special settings.

### Game
- [ ] Fetch the cover automatically when new songs are added through the admin panel.
- [ ] A daily challenge with the same song for everyone. This would need the server-side rounds that are already in place.
- [ ] Shareable results ("got it in 2 tries").

## Known limitations

- **Clips can be recognised with apps like Shazam.** Any audio a browser plays can be captured, which is inherent to this kind of game.
- **The `Referer`-based hotlink rule can be bypassed** by forging the header. It stops other websites and copied links, not a determined individual.
- **Rounds are kept in memory.** A restart ends the rounds in progress, and players get a new song automatically.
