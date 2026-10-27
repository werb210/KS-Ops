#!/usr/bin/env bash
# Provisions the Azure resources for one Keystone licensee. Safe to run again: anything that already exists is kept,
# and secrets already stored in the apps' settings are reused rather than replaced.
#
# Usage:
#   KS_OPS_URL=https://<ks-ops host> scripts/provision-licensee.sh <company_code> <region>
#   e.g. KS_OPS_URL=https://ks-ops.example.net scripts/provision-licensee.sh keystone-demo canadacentral
#
# Required environment:
#   KS_OPS_URL         KS-Ops base address (https). There is no default, so a licensee is never pointed at the wrong
#                      KS-Ops by accident.
#
# Optional environment:
#   KS_LICENSEE_ID     the licensee's id in KS-Ops (shown on its page in the staff portal)
#   KS_OPS_KEY         the licensee's ops key. If unset and OPS_TOKEN is set, a new key is made through KS-Ops.
#   OPS_TOKEN          a KS-Ops staff token (or OPS_ADMIN_TOKEN). With it the script also saves the new addresses
#                      on the licensee in KS-Ops, which then pushes the plan to the new server.
#   KS_PLAN            starter | growth | pro, written to KS-server as its starting plan (default starter)
#   OPENAI_API_KEY     written to KS-server and KS-Agent when set
#   QBO_CLIENT_ID      the licensee's Intuit app (QuickBooks Online fee invoices). With QBO_CLIENT_SECRET, written to
#   QBO_CLIENT_SECRET  KS-server together with QBO_ENVIRONMENT (sandbox | production, default sandbox) and
#   QBO_ENVIRONMENT    QBO_REDIRECT_URI (default <KS-server>/api/quickbooks/oauth/callback). QBO_TOKEN_ENCRYPTION_KEY
#   QBO_REDIRECT_URI   is made once and then kept. Without QBO_CLIENT_ID QuickBooks stays off. See KS-server
#                      docs/QUICKBOOKS.md.
#   NODE_RUNTIME       App Service runtime (default NODE:22-lts; KS-server's package.json requires Node 22)
#   APP_SKU            App Service plan size (default B1)
#   PG_SKU             Postgres size (default Standard_B1ms, Burstable)
#   PG_VERSION         Postgres version (default 17)
#   SWA_LOCATION       Static Web Apps region (default eastus2; Static Web Apps are not offered in Canadian regions)
#   CREATE_DEPLOY_SP=1 also create a deploy service principal limited to the resource group (AZURE_CREDENTIALS)
#   DEPLOY_IDENTITY=1  instead, create the managed identity ks-<code>-deploy (Website Contributor on the resource group)
#                      with GitHub federated credentials, so the deploy workflows sign in with no stored secret
#                      (environment variables AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_SUBSCRIPTION_ID). Needs
#                      permission to create role assignments. DEPLOY_IDENTITY_REPOS lists the repositories
#                      (default werb210/KS-server,werb210/KS-Agent).
#   OUTPUT_JSON        write the addresses and names (nothing secret) to this file as JSON
#   KS_NONINTERACTIVE=1  never print secrets (the "COPY THIS NOW" block is left out). Used by KS-Ops automatic
#                      provisioning (docs/AUTO_PROVISIONING.md), which writes the GitHub settings itself.
#
# Postgres only accepts connections from the KS-server and KS-Agent web apps' outbound addresses (one firewall rule
# per address, from `az webapp show --query possibleOutboundIpAddresses`); "allow all Azure services" is not used, and
# an existing 0.0.0.0 rule from an older run is removed.
#
# Requires: az (signed in, right subscription selected), openssl, curl. Never prints a secret except in the blocks
# marked "COPY THIS NOW", and never prints the database password.
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
command -v curl >/dev/null || { echo "curl is required." >&2; exit 2; }
az account show >/dev/null 2>&1 || { echo "Sign in first: az login" >&2; exit 2; }

if [[ -z "${KS_OPS_URL:-}" ]]; then
  echo "Set KS_OPS_URL to the KS-Ops base address, e.g. KS_OPS_URL=https://<ks-ops host> $0 $CODE $REGION" >&2
  exit 2
fi
KS_OPS_URL="${KS_OPS_URL%/}"
if [[ "$KS_OPS_URL" != https://* ]]; then
  echo "KS_OPS_URL must start with https:// (got $KS_OPS_URL)." >&2
  exit 2
fi
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
GH_ENV="ks-${CODE}"   # the GitHub environment the four deploy workflows use for this licensee

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
  # Public endpoint with no firewall rules yet; the web apps' addresses are added below once the apps exist.
  az postgres flexible-server create -g "$RG" -n "$PG" -l "$REGION" \
    --tier Burstable --sku-name "$PG_SKU" --storage-size 32 --version "$PG_VERSION" \
    --admin-user "$PG_ADMIN" --admin-password "$PG_PASSWORD" \
    --public-access None --yes --only-show-errors -o none
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

say "Postgres firewall: only the web apps' outbound addresses"
APP_IPS="$(for APP in "$SERVER_APP" "$AGENT_APP"; do
  az webapp show -g "$RG" -n "$APP" --query possibleOutboundIpAddresses -o tsv
done | tr ',' '\n' | sed 's/[[:space:]]//g' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u)"
if [[ -z "$APP_IPS" ]]; then
  echo "Could not read the web apps' outbound addresses (az webapp show --query possibleOutboundIpAddresses)." >&2
  exit 1
fi
while read -r IP; do
  [[ -n "$IP" ]] || continue
  RULE="ks-app-${IP//./-}"
  az postgres flexible-server firewall-rule create -g "$RG" -n "$PG" --rule-name "$RULE" \
    --start-ip-address "$IP" --end-ip-address "$IP" --only-show-errors -o none
  echo "allowed $IP"
done <<<"$APP_IPS"
# Remove "allow all Azure services" (0.0.0.0) and any other rule not made above.
for RULE in $(az postgres flexible-server firewall-rule list -g "$RG" -n "$PG" --query "[].name" -o tsv --only-show-errors); do
  if [[ "$RULE" != ks-app-* ]] || ! grep -qx "${RULE#ks-app-}" <<<"$(tr '.' '-' <<<"$APP_IPS")"; then
    az postgres flexible-server firewall-rule delete -g "$RG" -n "$PG" --rule-name "$RULE" --yes --only-show-errors -o none
    echo "removed rule $RULE"
  fi
done

SERVER_URL="https://$(az webapp show -g "$RG" -n "$SERVER_APP" --query defaultHostName -o tsv)"
AGENT_URL="https://$(az webapp show -g "$RG" -n "$AGENT_APP" --query defaultHostName -o tsv)"
PORTAL_URL="https://$(az staticwebapp show -g "$RG" -n "$PORTAL_SWA" --query defaultHostname -o tsv)"
CLIENT_URL="https://$(az staticwebapp show -g "$RG" -n "$CLIENT_SWA" --query defaultHostname -o tsv)"

# Secrets: keep what the apps already have.
JWT_SECRET="$(setting "$SERVER_APP" JWT_SECRET)"; [[ -n "$JWT_SECRET" ]] || JWT_SECRET="$(secret 32)"
OTP_HASH_SALT="$(setting "$SERVER_APP" OTP_HASH_SALT)"; [[ -n "$OTP_HASH_SALT" ]] || OTP_HASH_SALT="$(secret 32)"
# QuickBooks Online (KS-server v13): the token key is made once and kept, so connected companies stay connected.
QBO_TOKEN_ENCRYPTION_KEY="$(setting "$SERVER_APP" QBO_TOKEN_ENCRYPTION_KEY)"; [[ -n "$QBO_TOKEN_ENCRYPTION_KEY" ]] || QBO_TOKEN_ENCRYPTION_KEY="$(secret 32)"
# KS_OPS_AUTO_PROVISION_v1 - the other keys KS-server needs, also made once and kept: the refresh-token secret, the
# Google Workspace token key and the Apple Watch push-token key.
JWT_REFRESH_SECRET="$(setting "$SERVER_APP" JWT_REFRESH_SECRET)"; [[ -n "$JWT_REFRESH_SECRET" ]] || JWT_REFRESH_SECRET="$(secret 32)"
GOOGLE_TOKEN_ENCRYPTION_KEY="$(setting "$SERVER_APP" GOOGLE_TOKEN_ENCRYPTION_KEY)"; [[ -n "$GOOGLE_TOKEN_ENCRYPTION_KEY" ]] || GOOGLE_TOKEN_ENCRYPTION_KEY="$(secret 32)"
WATCH_PUSH_ENCRYPTION_KEY="$(setting "$SERVER_APP" WATCH_PUSH_ENCRYPTION_KEY)"; [[ -n "$WATCH_PUSH_ENCRYPTION_KEY" ]] || WATCH_PUSH_ENCRYPTION_KEY="$(openssl rand -base64 32)"
QBO_ENVIRONMENT="${QBO_ENVIRONMENT:-$(setting "$SERVER_APP" QBO_ENVIRONMENT)}"; QBO_ENVIRONMENT="${QBO_ENVIRONMENT:-sandbox}"
if [[ "$QBO_ENVIRONMENT" != "sandbox" && "$QBO_ENVIRONMENT" != "production" ]]; then
  echo "QBO_ENVIRONMENT must be sandbox or production (got $QBO_ENVIRONMENT)." >&2
  exit 2
fi
if [[ -n "${QBO_CLIENT_ID:-}" && -z "${QBO_CLIENT_SECRET:-}" ]]; then
  echo "QBO_CLIENT_ID is set but QBO_CLIENT_SECRET is not; give both, or neither." >&2
  exit 2
fi
KS_LICENSEE_ID="${KS_LICENSEE_ID:-$(setting "$SERVER_APP" KS_LICENSEE_ID)}"
if [[ -z "${KS_OPS_KEY:-}" ]]; then
  KS_OPS_KEY="$(setting "$SERVER_APP" KS_OPS_KEY)"
  if [[ -z "$KS_OPS_KEY" && -n "${OPS_TOKEN:-}" && -n "$KS_LICENSEE_ID" ]]; then
    say "Making a new ops key in KS-Ops"
    if ! ROTATE_RESPONSE="$(curl -fsS -X POST "$KS_OPS_URL/api/ops/licensees/$KS_LICENSEE_ID/ops-key" \
      -H "Authorization: Bearer $OPS_TOKEN")"; then
      echo "KS-Ops did not make a new ops key (curl failed; check KS_OPS_URL, OPS_TOKEN and KS_LICENSEE_ID)." >&2
      exit 1
    fi
    KS_OPS_KEY="$(sed -n 's/.*"ops_key":"\(ksops_[A-Za-z0-9_-]*\)".*/\1/p' <<<"$ROTATE_RESPONSE")"
    unset ROTATE_RESPONSE
    if [[ -z "$KS_OPS_KEY" ]]; then
      echo "KS-Ops answered, but its reply had no ops key that could be read. The key may have been rotated anyway:" >&2
      echo "rotate it again in Keystone operations and set KS_OPS_KEY on $SERVER_APP by hand." >&2
      exit 1
    fi
  fi
fi

say "KS-server settings"
SERVER_SETTINGS=(
  "DATABASE_URL=$DATABASE_URL"
  "JWT_SECRET=$JWT_SECRET"
  "OTP_HASH_SALT=$OTP_HASH_SALT"
  "JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET"
  "GOOGLE_TOKEN_ENCRYPTION_KEY=$GOOGLE_TOKEN_ENCRYPTION_KEY"
  "WATCH_PUSH_ENCRYPTION_KEY=$WATCH_PUSH_ENCRYPTION_KEY"
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
SERVER_SETTINGS+=("QBO_TOKEN_ENCRYPTION_KEY=$QBO_TOKEN_ENCRYPTION_KEY" "QBO_ENVIRONMENT=$QBO_ENVIRONMENT")
if [[ -n "${QBO_CLIENT_ID:-}" ]]; then
  SERVER_SETTINGS+=("QBO_CLIENT_ID=$QBO_CLIENT_ID" "QBO_CLIENT_SECRET=$QBO_CLIENT_SECRET"
    "QBO_REDIRECT_URI=${QBO_REDIRECT_URI:-$SERVER_URL/api/quickbooks/oauth/callback}")
fi
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
  if ! curl -fsS -o /dev/null -X PATCH "$KS_OPS_URL/api/ops/licensees/$KS_LICENSEE_ID" \
    -H "Authorization: Bearer $OPS_TOKEN" -H "Content-Type: application/json" \
    -d "{\"server_url\":\"$SERVER_URL\",\"portal_url\":\"$PORTAL_URL\",\"client_url\":\"$CLIENT_URL\"}"; then
    echo "KS-Ops did not save the addresses; set them on the licensee in Keystone operations by hand." >&2
    exit 1
  fi
  echo "done - KS-Ops will push the plan to the new server once it is running"
fi

DEPLOY_CREDS=""
if [[ "${CREATE_DEPLOY_SP:-}" == "1" ]]; then
  say "Deploy service principal ks-${CODE}-deploy (contributor on $RG only)"
  RG_ID="$(az group show -n "$RG" --query id -o tsv)"
  DEPLOY_CREDS="$(az ad sp create-for-rbac --name "ks-${CODE}-deploy" --role contributor --scopes "$RG_ID" --json-auth --only-show-errors)"
fi

DEPLOY_CLIENT_ID=""
if [[ "${DEPLOY_IDENTITY:-}" == "1" ]]; then
  IDENTITY="ks-${CODE}-deploy"
  say "Deploy identity $IDENTITY (Website Contributor on $RG, GitHub federated credentials)"
  if exists az identity show -g "$RG" -n "$IDENTITY"; then echo "exists"; else
    az identity create -g "$RG" -n "$IDENTITY" -l "$REGION" --only-show-errors -o none
  fi
  DEPLOY_CLIENT_ID="$(az identity show -g "$RG" -n "$IDENTITY" --query clientId -o tsv)"
  PRINCIPAL_ID="$(az identity show -g "$RG" -n "$IDENTITY" --query principalId -o tsv)"
  RG_ID="$(az group show -n "$RG" --query id -o tsv)"
  if [[ -z "$(az role assignment list --assignee "$PRINCIPAL_ID" --role "Website Contributor" --scope "$RG_ID" --query "[0].id" -o tsv --only-show-errors)" ]]; then
    # A new identity can take a minute to reach Entra ID; try a few times.
    for TRY in 1 2 3 4 5 6; do
      if az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
        --role "Website Contributor" --scope "$RG_ID" --only-show-errors -o none; then break; fi
      [[ "$TRY" == 6 ]] && { echo "Could not give $IDENTITY the Website Contributor role on $RG." >&2; exit 1; }
      sleep 20
    done
  fi
  IFS=',' read -r -a FED_REPOS <<<"${DEPLOY_IDENTITY_REPOS:-werb210/KS-server,werb210/KS-Agent}"
  for FED_REPO in "${FED_REPOS[@]}"; do
    FED_NAME="github-${FED_REPO##*/}-${GH_ENV}"
    FED_NAME="${FED_NAME//[^A-Za-z0-9-]/-}"
    if exists az identity federated-credential show -g "$RG" --identity-name "$IDENTITY" -n "$FED_NAME"; then echo "federated credential $FED_NAME exists"; else
      az identity federated-credential create -g "$RG" --identity-name "$IDENTITY" -n "$FED_NAME" \
        --issuer https://token.actions.githubusercontent.com --subject "repo:${FED_REPO}:environment:${GH_ENV}" \
        --audiences api://AzureADTokenExchange --only-show-errors -o none
      echo "federated credential $FED_NAME for $FED_REPO environment $GH_ENV"
    fi
  done
fi

if [[ -n "${OUTPUT_JSON:-}" ]]; then
  cat >"$OUTPUT_JSON" <<JSON
{"code":"$CODE","resource_group":"$RG","server_url":"$SERVER_URL","agent_url":"$AGENT_URL","portal_url":"$PORTAL_URL","client_url":"$CLIENT_URL","deploy_client_id":"$DEPLOY_CLIENT_ID","tenant_id":"$(az account show --query tenantId -o tsv)","subscription_id":"$(az account show --query id -o tsv)"}
JSON
fi

if [[ "${KS_NONINTERACTIVE:-}" == "1" ]]; then
  echo
  echo "Keystone licensee \"$CODE\" is provisioned in resource group $RG (server $SERVER_URL, portal $PORTAL_URL, client $CLIENT_URL)."
  exit 0
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
  Postgres      host $(az postgres flexible-server show -g "$RG" -n "$PG" --query fullyQualifiedDomainName -o tsv)
                database $DB, user $PG_ADMIN, sslmode=require
                The password is stored only in the DATABASE_URL app setting of $SERVER_APP. To read it:
                az webapp config appsettings list -g $RG -n $SERVER_APP --query "[?name=='DATABASE_URL'].value" -o tsv

GitHub: each of KS-server, KS-Agent, KS-Portal and KS-Client deploys this licensee from a GitHub environment named
  $GH_ENV  (repo Settings > Environments > New environment, in each of the four repositories)
and a registry entry in deploy/licensees.json of each of the four repositories (same line in all four):
  { "code": "$CODE", "environment": "$GH_ENV", "enabled": true, "apps": ["server", "agent", "portal", "client"] }

Environment variables (not secret), per repository:
  KS-server  AZURE_WEBAPP_NAME = $SERVER_APP      (optional: this is the default)
  KS-Agent   AZURE_WEBAPP_NAME = $AGENT_APP       (optional: this is the default)
  KS-Portal  VITE_API_BASE_URL = $SERVER_URL
             VITE_APP_URL = $PORTAL_URL
             VITE_CLIENT_APP_URL = $CLIENT_URL
             VITE_MSAL_REDIRECT_URI = $PORTAL_URL
             (No Microsoft or Google app per licensee: Keystone's apps are written to KS-server by KS-Ops, and the
             brokerage's admin connects Microsoft 365 in one click under Settings > Connections.)
  KS-Client  VITE_API_BASE_URL = $SERVER_URL
             VITE_CLIENT_APP_URL = $CLIENT_URL
             VITE_LICENSEE = <folder under KS-Client licensees/> (optional: the branded build)
Environment secrets, per repository (values in the COPY THIS NOW block below):
  KS-server  AZURE_CREDENTIALS
  KS-Agent   AZURE_CREDENTIALS
  KS-Portal  AZURE_STATIC_WEB_APPS_API_TOKEN (the portal's token)
  KS-Client  AZURE_STATIC_WEB_APPS_API_TOKEN (the client's token)
KS-server needs no DATABASE_URL in GitHub: it migrates on startup with its DATABASE_URL app setting.
SUMMARY
[[ -n "$KS_LICENSEE_ID" ]] || echo "  Note: KS_LICENSEE_ID was not given, so KS-server cannot report usage to KS-Ops yet."
[[ -n "${KS_OPS_KEY:-}" ]] || echo "  Note: no ops key was set on KS-server. Rotate one in KS-Ops and set KS_OPS_KEY on $SERVER_APP."
[[ -n "${OPENAI_API_KEY:-}" ]] || echo "  Note: OPENAI_API_KEY was not given; set it on $SERVER_APP and $AGENT_APP."
QBO_ID_NOW="${QBO_CLIENT_ID:-$(setting "$SERVER_APP" QBO_CLIENT_ID)}"
cat <<QBO

QuickBooks Online (fee invoices, optional):
  Redirect URI to add to the licensee's Intuit app (Keys & credentials, $QBO_ENVIRONMENT keys):
    ${QBO_REDIRECT_URI:-$SERVER_URL/api/quickbooks/oauth/callback}
  KS-server settings: QBO_TOKEN_ENCRYPTION_KEY (made once, kept), QBO_ENVIRONMENT=$QBO_ENVIRONMENT$( [[ -n "$QBO_ID_NOW" ]] && echo ", QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI" )
  Or, in the KS-server GitHub environment $GH_ENV: secrets QBO_CLIENT_ID, QBO_CLIENT_SECRET; variable
  QBO_ENVIRONMENT. The KS-server deploy then writes them. An admin then connects in Settings > Company.
QBO
[[ -n "$QBO_ID_NOW" ]] || echo "  Note: QBO_CLIENT_ID was not given, so QuickBooks stays off until it is set (with QBO_CLIENT_SECRET) on $SERVER_APP."

cat <<SECRETS

------------------------------------ COPY THIS NOW ------------------------------------------------
GitHub secrets. They are not saved anywhere else by this script; run it again to print them again.
(The database password is not printed: it lives in $SERVER_APP's DATABASE_URL app setting, see above.)

GitHub environment $GH_ENV:
  KS-Portal  AZURE_STATIC_WEB_APPS_API_TOKEN = $PORTAL_TOKEN
  KS-Client  AZURE_STATIC_WEB_APPS_API_TOKEN = $CLIENT_TOKEN
SECRETS
if [[ -n "$DEPLOY_CREDS" ]]; then
  echo "  KS-server and KS-Agent  AZURE_CREDENTIALS ="
  echo "$DEPLOY_CREDS" | sed 's/^/    /'
else
  echo "  KS-server and KS-Agent  AZURE_CREDENTIALS: not made (run again with CREATE_DEPLOY_SP=1, or reuse the licensee's"
  echo "  existing ks-$CODE-deploy service principal's JSON)."
fi
echo "---------------------------------------------------------------------------------------------------"
