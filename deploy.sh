#!/bin/zsh
# Deploy the pad app to <pod>/pad/ and make it public-read (only the owner can write).
# Re-runnable: app files are overwritten, pad.ttl is only created if missing.
set -euo pipefail
HERE=${0:A:h}
# Needs SOLID_CLIENT_ID, SOLID_CLIENT_SECRET, SOLID_WEBID, SOLID_POD_ROOT: from the
# environment (GitHub Actions) or from an env file (default ../.env, override with ENV_FILE).
ENV_FILE=${ENV_FILE:-$HERE/../.env}
if [[ -f $ENV_FILE ]]; then set -a; . "$ENV_FILE"; set +a; fi
: ${SOLID_CLIENT_ID:?} ${SOLID_CLIENT_SECRET:?} ${SOLID_WEBID:?} ${SOLID_POD_ROOT:?}
DEST="${SOLID_POD_ROOT}pad/"

tok() {
  curl -sf -u "$SOLID_CLIENT_ID:$SOLID_CLIENT_SECRET" -d grant_type=client_credentials \
    -d scope="openid webid" https://login.inrupt.com/token |
    python3 -I -c "import json,sys;print(json.load(sys.stdin)['access_token'])"
}
T=$(tok)

put() { # put <file> <name> <content-type>
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H "Authorization: Bearer $T" \
    -H "Content-Type: $3" --data-binary "@$1" "$DEST$2")
  echo "PUT $2 -> $code"
  [[ $code == 20* ]]
}

make_public_read() { # adds a public Read policy to the resource's ACR, keeping existing ones
  local url=$1 acr cur
  acr=$(curl -s -I -H "Authorization: Bearer $T" "$url" | grep -i 'rel="acl"' | sed -E 's/.*<([^>]+)>.*/\1/')
  cur=$(curl -s -H "Authorization: Bearer $T" -H "Accept: text/turtle" "$acr")
  if [[ $cur == *"#publicRead"* ]]; then echo "ACR ${url##*/} already public-read"; return; fi
  local body="$cur
<$acr> <http://www.w3.org/ns/solid/acp#accessControl> <$acr#publicAC> .
<$acr#publicAC> a <http://www.w3.org/ns/solid/acp#AccessControl> ;
  <http://www.w3.org/ns/solid/acp#apply> <$acr#publicRead> .
<$acr#publicRead> a <http://www.w3.org/ns/solid/acp#Policy> ;
  <http://www.w3.org/ns/solid/acp#allow> <http://www.w3.org/ns/auth/acl#Read> ;
  <http://www.w3.org/ns/solid/acp#anyOf> <$acr#anyone> .
<$acr#anyone> a <http://www.w3.org/ns/solid/acp#Matcher> ;
  <http://www.w3.org/ns/solid/acp#agent> <http://www.w3.org/ns/solid/acp#PublicAgent> ."
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H "Authorization: Bearer $T" \
    -H "Content-Type: text/turtle" --data-binary "$body" "$acr")
  echo "ACR ${url##*/} public-read -> $code"
}

put "$HERE/index.html" index.html text/html
put "$HERE/app.js" app.js application/javascript

if [[ $(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $T" "${DEST}pad.ttl") == 404 ]]; then
  SEED=$(mktemp)
  cat > "$SEED" <<EOF
@prefix pad: <http://www.w3.org/ns/pim/pad#> .
@prefix sioc: <http://rdfs.org/sioc/ns#> .
@prefix dc: <http://purl.org/dc/elements/1.1/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<#thisPad> a pad:Notepad ;
  dc:author <$SOLID_WEBID> ;
  dc:created "$(date -u +%Y-%m-%dT%H:%M:%SZ)"^^xsd:dateTime ;
  pad:next <#c0> .
<#c0> sioc:content "Hello from my Pod." ; dc:author <$SOLID_WEBID> ; pad:next <#thisPad> .
EOF
  put "$SEED" pad.ttl text/turtle
  rm -f "$SEED"
else
  echo "pad.ttl exists, leaving its text alone"
fi

for f in index.html app.js pad.ttl; do make_public_read "$DEST$f"; done

echo "--- anonymous check"
for f in index.html app.js pad.ttl; do
  echo "$(curl -s -o /dev/null -w "%{http_code}" "$DEST$f") GET $f"
done
echo "$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H "Content-Type: text/plain" --data-binary x "${DEST}pad.ttl") anonymous PUT pad.ttl (expect 401)"
echo
echo "Open: ${DEST}index.html"
