#!/bin/bash
# ניסוי: האם Mosquitto מצבור הודעות לגשר בזמן שהיעד למטה?
#
# הטענה בקוד (Worker.cs:596-599): "בזמן נתק אינטרנט ה-Agent ממשיך לשדר
# ל-Mosquitto המקומי, שמצבור את ההודעות ומזרים אותן כשהגשר חוזר".
# אבל BridgeConfigWriter.cs:157 מגדיר cleansession true.
#
# ⚠️ שתי טעויות מדידה שכבר תוקנו כאן, ושתיהן החזירו "0 מתוך 5" מזויף:
#   1. נתיבי persistence בצורת Git Bash — mosquitto של Windows לא עולה כלל
#   2. המנוי בענן הורם אחרי שהגשר התחבר מחדש, ואז ההודעות הגיעו לברוקר
#      שאין לו למי למסור

M="/c/Program Files/mosquitto"
BASE="$(cd "$(dirname "$0")" && pwd)/cs-test"
WBASE="$(cygpath -m "$BASE" 2>/dev/null || echo "$BASE")"
rm -rf "$BASE"; mkdir -p "$BASE/site"
RESULT="$(dirname "$BASE")/cleansession-result.txt"
: > "$RESULT"

say() { echo "$1" | tee -a "$RESULT"; }

cat > "$BASE/cloud.conf" <<EOF
listener 18841
allow_anonymous true
EOF

mk_site() {
  cat > "$BASE/site-$1.conf" <<EOF
listener 18831
allow_anonymous true
persistence true
persistence_location $WBASE/site/

connection cloudbridge
address 127.0.0.1:18841
topic sites/9999/# out 1
max_queued_messages 0
try_private false
remote_clientid bridge-9999
local_clientid bridge-9999
keepalive_interval 60
cleansession $1
EOF
}

run_variant() {
  local CS="$1"
  say ""
  say "════════ cleansession $CS ════════"
  mk_site "$CS"
  rm -rf "$BASE/site"; mkdir -p "$BASE/site"
  : > "$BASE/got-$CS.txt"

  "$M/mosquitto.exe" -v -c "$BASE/cloud.conf" > "$BASE/cloud-$CS.log" 2>&1 &
  local CLOUD=$!
  sleep 2

  "$M/mosquitto.exe" -v -c "$BASE/site-$CS.conf" > "$BASE/site-$CS.log" 2>&1 &
  local SITE=$!
  sleep 5
  local UP
  UP=$(grep -ci 'bridge-9999' "$BASE/cloud-$CS.log" 2>/dev/null); UP=${UP:-0}
  say "גשר מחובר בתחילה: $UP אזכורים בלוג הענן"

  kill $CLOUD 2>/dev/null; wait $CLOUD 2>/dev/null
  say "הענן ירד."
  sleep 3

  for i in 1 2 3 4 5; do
    "$M/mosquitto_pub.exe" -h 127.0.0.1 -p 18831 -t 'sites/9999/state' \
        -q 1 -m "{\"timestamp\":$i,\"state\":\"ready\"}" 2>/dev/null
  done
  say "פורסמו 5 הודעות ל-Mosquitto המקומי בזמן שהענן למטה."
  sleep 2

  "$M/mosquitto.exe" -v -c "$BASE/cloud.conf" > "$BASE/cloud2-$CS.log" 2>&1 &
  CLOUD=$!
  sleep 1
  "$M/mosquitto_sub.exe" -h 127.0.0.1 -p 18841 -t 'sites/9999/#' -q 1 \
      >> "$BASE/got-$CS.txt" 2>&1 &
  local SUB=$!
  say "הענן חזר והמנוי מאזין. ממתין 35 שניות לחיבור מחדש של הגשר..."
  sleep 35
  kill $SUB 2>/dev/null; wait $SUB 2>/dev/null

  local N RECON
  N=$(grep -c 'timestamp' "$BASE/got-$CS.txt" 2>/dev/null); N=${N:-0}
  RECON=$(grep -ci 'bridge-9999' "$BASE/cloud2-$CS.log" 2>/dev/null); RECON=${RECON:-0}

  say "───────────────────────────────"
  say "הגשר התחבר מחדש: $RECON אזכורים"
  say "הגיעו $N מתוך 5"
  if   [ "$RECON" -eq 0 ]; then say "⚠️ הגשר לא הספיק להתחבר — המדידה אינה תקפה"
  elif [ "$N" -eq 5 ];     then say "✅ כל ההודעות שרדו את הנתק"
  elif [ "$N" -eq 0 ];     then say "❌ כל ההודעות אבדו"
  else                          say "⚠️ אבדו חלקית"; fi

  kill $SITE $CLOUD 2>/dev/null; wait 2>/dev/null
  sleep 2
}

say "ניסוי: האם Mosquitto מצבור לגשר בזמן שהיעד למטה"
say "(הקונפיג מועתק מ-BridgeConfigWriter.cs)"
run_variant true
run_variant false
say ""
say "cleansession true  = מה שהסוכן מייצר היום"
say "cleansession false = ברירת המחדל של Mosquitto"
