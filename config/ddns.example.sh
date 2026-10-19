#!/usr/bin/env bash
set -euo pipefail
# Обновява A записа в Cloudflare, ако публичното IP на машината се смени (няма Elastic IP).
# Пуска се от cron на всеки 5 мин. CF_TOKEN: API токен само с право Zone → DNS → Edit за тази зона.
CF_TOKEN="REPLACE_ME"
ZONE_ID="REPLACE_ME"
RECORD_NAME="chalgadle.com"

current_ip=$(curl -s https://api.ipify.org || true)
[[ "$current_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 0

resp=$(curl -s -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?type=A&name=$RECORD_NAME")
record_id=$(echo "$resp" | python3 -c "import sys,json;print(json.load(sys.stdin)['result'][0]['id'])")
old_ip=$(echo "$resp" | python3 -c "import sys,json;print(json.load(sys.stdin)['result'][0]['content'])")

if [ "$current_ip" != "$old_ip" ]; then
  curl -s -X PUT -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$record_id" \
    --data "{\"type\":\"A\",\"name\":\"$RECORD_NAME\",\"content\":\"$current_ip\",\"proxied\":true,\"ttl\":1}" >/dev/null
  echo "$(date '+%F %T') updated $old_ip -> $current_ip"
else
  echo "$(date '+%F %T') unchanged ($current_ip)"
fi
