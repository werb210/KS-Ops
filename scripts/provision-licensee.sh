#!/usr/bin/env bash
# Provisions the Azure resources for one Keystone licensee. Safe to run again: anything that already exists is kept,
# and secrets already stored in the apps' settings are reused rather than replaced.
#
# Usage:
#   scripts/provision-licensee.sh <company_code> <region>
#   e.g. scripts/provision-licensee.sh keystone-demo canadacentral
#
# Optional environment:
#   KS_OPS_URL         KS-Ops base address (default https://ks-ops.azurewebsites.net)
#   KS_LICENSEE_ID     the licensee's id in KS-Ops (shown on its page in the staff portal)
#   KS_OPS_KEY         the licensee's ops key. If unset and OPS_TOKEN is set, a new key is made through KS-Ops.
#   OPS_TOKEN          a KS-Ops staff token (or OPS_ADMIN_TOKEN). With it the script also saves the new addresses
#                      on the licensee in KS-Ops, which then pushes the plan to the new server.
#   KS_PLAN            starter | growth | pro, written to KS-server as its starting plan (default starter)
#   OPENAI_API_KEY     written to KS-server and KS-Agent when set
#   NODE_RUNTIME       App Service runtime (default NODE:22-lts; KS-server's package.json requires Node 22)
#   APP_SKU            App Service plan size (default B1)
#   PG_SKU             Postgres size (default Standard_B1ms, Burstable)
#   PG_VERSION         Postgres version (default 17)
#   SWA_LOCATION       Static Web Apps region (default eastus2; Static Web Apps are not offered in Canadian regions)
#   CREATE_DEPLOY_SP=1 also create a deploy service principal limited to the resource group (AZURE_CREDENTIALS)
#
# Requires: az (signed in, right subscription selected), openssl, curl. Never prints a secret except in the blocks
# marked "COPY THIS NOW".
set -euo pipefail

CODE="${1:-}"
REGION="${2:-}"
if [[ -z "$CODE" || -z "$REGION" ]]; then
  echo "Usage: $0 <company_code> <region>" >&2
  exit 2
fi
if ! [[ "$CODE" =~ ^[a-z0-9]([a-z0-9-]{1,30})[a-z0-9]$ ]] || [[ "$CODE" == *--* ]]; then
  echo "The company code must be 3-32 lowercase letters, numbers or single hyphens." >&2
  exit 2
fi
command -v az >/dev/null || { echo "Azure CLI (az) is required." >&2; exit 2; }
command -v openssl >/dev/null || { echo "openssl is required." >&2; exit 2; }
az account show >/dev/null 2>&1 || { echo "Sign in first: az login" >&2; exit 2; }

KS_OPS_URL="${KS_OPS_URL:-https://ks-ops.azurewebsites.net}"
KS_OPS_URL="${KS_OPS_URL%/}"
KS_PLAN="${KS_PLAN:-starter}"
NODE_RUNTIME="${NODE_RUNTIME:-NODE:22-lts}"
APP_SKU="${APP_SKU:-B1}"
PG_SKU="${PG_SKU:-Standard_B1ms}"
PG_VERSION="${PG_VERSION:-17}"
SWA_LOCATION="${SWA_LOCATION:-eastus2}"

RG="ks-${CODE}"
PLAN="ks-${CODE}-plan"
PG="ks-${CODE}-pg"
DB="ks"
PG_ADMIN="ksadmin"
SERVER_APP="ks-${CODE}-server"
AGENT_APP="ks-${CODE}-agent"
PORTAL_SWA="ks-${CODE}-portal"
CLIENT_SWA="ks-${CODE}-client"

say() { printf '\n==> %s\n' "$*"; }
exists() { "$@" --only-show-errors >/dev/null 2>&1; }
setting() { # setting <app> <name> -> current value or empty
  az webapp config appsettings list -g "$RG" -n "$1" --query "[?name=='$2'].value | [0]" -o tsv --only-show-errors 2>/dev/null || true
}
secret() { openssl rand -hex "${1:-32}"; }

say "Resource group $RG ($REGION)"
if exists az group show -n "$RG"; then echo "exists"; else
  az group create -n "$RG" -l "$REGION" --tags keystone-licensee="$CODE" --only-show-errors -o none
fi

say "Postgres flexible server $PG"
DATABASE_URL="$(exists az webapp show -g "$RG" -n "$SERVER_APP" && setting "$SERVER_APP" DATABASE_URL || true)"
if exists az postgres flexible-server show -g "$RG" -n "$PG"; then
  echo "exists"
  if [[ -z "$DATABASE_URL" ]]; then
    echo "The server exists but KS-server has no DATABASE_URL yet, so its password is unknown." >&2
    echo "Reset it with: az postgres flexible-server update -g $RG -n $PG --admin-password <new>, then set DATABASE_URL on $SERVER_APP." >&2
    exit 1
  fi
else
  PG_PASSWORD="$(secret 24)"
  az postgres flexible-server create -g "$RG" -n "$PG" -l "$REGION" \
    --tier Burstable --sku-name "$PG_SKU" --storage-size 32 --version "$PG_VERSION" \
    --admin-user "$PG_ADMIN" --admin-password "$PG_PASSWORD" \
    --public-access 0.0.0.0 --yes --only-show-errors -o none
  PG_HOST="$(az postgres flexible-server show -g "$RG" -n "$PG" --query fullyQualifiedDomainName -o tsv)"
  DATABASE_URL="postgresql://${PG_ADMIN}:${PG_PASSWORD}@${PG_HOST}:5432/${DB}?sslmode=require"
  unset PG_PASSWORD
fi
if exists az postgres flexible-server db show -g "$RG" -s "$PG" -d "$DB"; then echo "database $DB exists"; else
  az postgres flexible-server db create -g "$RG" -s "$PG" -d "$DB" --only-show-errors -o none
fi

say "App Service plan $PLAN ($APP_SKU, Linux)"
if exists az appservice plan show -g "$RG" -n "$PLAN"; then echo "exists"; else
  az appservice plan create -g "$RG" -n "$PLAN" -l "$REGION" --is-linux --sku "$APP_SKU" --only-show-errors -o none
fi

for APP in "$SERVER_APP" "$AGENT_APP"; do
  say "Web app $APP ($NODE_RUNTIME)"
  if exists az webapp show -g "$RG" -n "$APP"; then echo "exists"; else
    az webapp create -g "$RG" -p "$PLAN" -n "$APP" --runtime "$NODE_RUNTIME" --only-show-errors -o none
  fi
  az webapp config set -g "$RG" -n "$APP" --startup-file "node dist/index.js" --always-on true \
    --http20-enabled true --min-tls-version 1.2 --only-show-errors -o none
  az webapp update -g "$RG" -n "$APP" --https-only true --only-show-errors -o none
done

for SWA in "$PORTAL_SWA" "$CLIENT_SWA"; do
  say "Static Web App $SWA ($SWA_LOCATION)"
  if exists az staticwebapp show -g "$RG" -n "$SWA"; then echo "exists"; else
    az staticwebapp create -g "$RG" -n "$SWA" -l "$SWA_LOCATION" --sku Free --only-show-errors -o none
  fi
done

SERVER_URL="https://$(az webapp show -g "$RG" -n "$SERVER_APP" --query defaultHostName -o tsv)"
AGENT_URL="https://$(az webapp show -g "$RG" -n "$AGENT_APP" --query defaultHostName -o tsv)"
PORTAL_URL="https://$(az staticwebapp show -g "$RG" -n "$PORTAL_SWA" --query defaultHostname -o tsv)"
CLIENT_URL="https://$(az staticwebapp show -g "$RG" -n "$CLIENT_SWA" --query defaultHostname -o tsv)"

# Secrets: keep what the apps already have.
JWT_SECRET="$(setting "$SERVER_APP" JWT_SECRET)"; [[ -n "$JWT_SECRET" ]] || JWT_SECRET="$(secret 32)"
OTP_HASH_SALT="$(setting "$SERVER_APP" OTP_HASH_SALT)"; [[ -n "$OTP_HASH_SALT" ]] || OTP_HASH_SALT="$(secret 32)"
KS_LICENSEE_ID="${KS_LICENSEE_ID:-$(setting "$SERVER_APP" KS_LICENSEE_ID)}"
if [[ -z "${KS_OPS_KEY:-}" ]]; then
  KS_OPS_KEY="$(setting "$SERVER_APP" KS_OPS_KEY)"
  if [[ -z "$KS_OPS_KEY" && -n "${OPS_TOKEN:-}" && -n "$KS_LICENSEE_ID" ]]; then
    say "Making a new ops key in KS-Ops"
    KS_OPS_KEY="$(curl -fsS -X POST "$KS_OPS_URL/api/ops/licensees/$KS_LICENSEE_ID/ops-key" \
      -H "Authorization: Bearer $OPS_TOKEN" | sed -n 's/.*"ops_key":"\([^"]*\)".*/\1/p')"
  fi
fi

say "KS-server settings"
SERVER_SETTINGS=(
  "DATABASE_URL=$DATABASE_URL"
  "JWT_SECRET=$JWT_SECRET"
  "OTP_HASH_SALT=$OTP_HASH_SALT"
  "NODE_ENV=production"
  "SCM_DO_BUILD_DURING_DEPLOYMENT=false"
  "KS_SERVER_URL=$SERVER_URL"
  "KS_PORTAL_URL=$PORTAL_URL"
  "KS_CLIENT_URL=$CLIENT_URL"
  "KS_OPS_URL=$KS_OPS_URL"
  "MAYA_URL=$AGENT_URL"
)
[[ -n "$(setting "$SERVER_APP" KS_PLAN)" ]] || SERVER_SETTINGS+=("KS_PLAN=$KS_PLAN")
[[ -n "$KS_LICENSEE_ID" ]] && SERVER_SETTINGS+=("KS_LICENSEE_ID=$KS_LICENSEE_ID")
[[ -n "${KS_OPS_KEY:-}" ]] && SERVER_SETTINGS+=("KS_OPS_KEY=$KS_OPS_KEY")
[[ -n "${OPENAI_API_KEY:-}" ]] && SERVER_SETTINGS+=("OPENAI_API_KEY=$OPENAI_API_KEY")
az webapp config appsettings set -g "$RG" -n "$SERVER_APP" --settings "${SERVER_SETTINGS[@]}" --only-show-errors -o none
echo "saved ${#SERVER_SETTINGS[@]} settings"

say "KS-Agent settings"
AGENT_SETTINGS=(
  "SERVER_URL=$SERVER_URL"
  "JWT_SECRET=$JWT_SECRET"
  "NODE_ENV=production"
  "SCM_DO_BUILD_DURING_DEPLOYMENT=false"
)
[[ -n "${OPENAI_API_KEY:-}" ]] && AGENT_SETTINGS+=("OPENAI_API_KEY=$OPENAI_API_KEY")
az webapp config appsettings set -g "$RG" -n "$AGENT_APP" --settings "${AGENT_SETTINGS[@]}" --only-show-errors -o none
echo "saved ${#AGENT_SETTINGS[@]} settings"

if [[ -n "${OPS_TOKEN:-}" && -n "$KS_LICENSEE_ID" ]]; then
  say "Saving the addresses in KS-Ops"
  curl -fsS -o /dev/null -X PATCH "$KS_OPS_URL/api/ops/licensees/$KS_LICENSEE_ID" \
    -H "Authorization: Bearer $OPS_TOKEN" -H "Content-Type: application/json" \
    -d "{\"server_url\":\"$SERVER_URL\",\"portal_url\":\"$PORTAL_URL\",\"client_url\":\"$CLIENT_URL\"}"
  echo "done - KS-Ops will push the plan to the new server once it is running"
fi

DEPLOY_CREDS=""
if [[ "${CREATE_DEPLOY_SP:-}" == "1" ]]; then
  say "Deploy service principal ks-${CODE}-deploy (contributor on $RG only)"
  RG_ID="$(az group show -n "$RG" --query id -o tsv)"
  DEPLOY_CREDS="$(az ad sp create-for-rbac --name "ks-${CODE}-deploy" --role contributor --scopes "$RG_ID" --json-auth --only-show-errors)"
fi

PORTAL_TOKEN="$(az staticwebapp secrets list -g "$RG" -n "$PORTAL_SWA" --query properties.apiKey -o tsv)"
CLIENT_TOKEN="$(az staticwebapp secrets list -g "$RG" -n "$CLIENT_SWA" --query properties.apiKey -o tsv)"

cat <<SUMMARY

==================================================================================================
Keystone licensee "$CODE" is provisioned in resource group $RG.

  KS-server     $SERVER_URL      (App Service $SERVER_APP)
  KS-Agent      $AGENT_URL       (App Service $AGENT_APP)
  KS-Portal     $PORTAL_URL      (Static Web App $PORTAL_SWA)
  KS-Client     $CLIENT_URL      (Static Web App $CLIENT_SWA)
  Postgres      $PG / database $DB

GitHub variables (not secret):
  KS-server  AZURE_WEBAPP_NAME = $SERVER_APP
  KS-Agent   AZURE_WEBAPP_NAME = $AGENT_APP
  KS-Portal  VITE_API_BASE_URL = $SERVER_URL      (the workflow reads it as a secret today)
             VITE_APP_URL = $PORTAL_URL
             VITE_CLIENT_APP_URL = $CLIENT_URL
             VITE_MSAL_REDIRECT_URI = $PORTAL_URL
             VITE_MSAL_CLIENT_ID / VITE_MSAL_TENANT_ID / VITE_MSAL_SCOPES = the licensee's Microsoft app (set up separately)
  KS-Client  VITE_API_BASE_URL = $SERVER_URL      (the build reads client-app/.env.production today)
SUMMARY
[[ -n "$KS_LICENSEE_ID" ]] || echo "  Note: KS_LICENSEE_ID was not given, so KS-server cannot report usage to KS-Ops yet."
[[ -n "${KS_OPS_KEY:-}" ]] || echo "  Note: no ops key was set on KS-server. Rotate one in KS-Ops and set KS_OPS_KEY on $SERVER_APP."
[[ -n "${OPENAI_API_KEY:-}" ]] || echo "  Note: OPENAI_API_KEY was not given; set it on $SERVER_APP and $AGENT_APP."

cat <<SECRETS

------------------------------------ COPY THIS NOW ------------------------------------------------
GitHub secrets. They are not saved anywhere else by this script; run it again to print them again.

  KS-server  DATABASE_URL = $DATABASE_URL
  KS-Portal  AZURE_STATIC_WEB_APPS_API_TOKEN = $PORTAL_TOKEN
  KS-Client  AZURE_STATIC_WEB_APPS_API_TOKEN = $CLIENT_TOKEN
SECRETS
if [[ -n "$DEPLOY_CREDS" ]]; then
  echo "  KS-server and KS-Agent  AZURE_CREDENTIALS ="
  echo "$DEPLOY_CREDS" | sed 's/^/    /'
fi
echo "---------------------------------------------------------------------------------------------------"
