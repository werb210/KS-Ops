#!/usr/bin/env bash
# KS_SHARED_HOSTING_v1 - creates Keystone's shared hosting, ONCE (not per brokerage). Safe to run again: whatever
# exists is kept, and the keys already saved on the apps are reused.
#
#   resource group     ks-shared (canadacentral)
#   App Service plan   ks-shared-plan (Linux)
#   web apps           ks-shared-server (KS-server), ks-shared-agent (KS-Agent), ks-shared-web (web host, web-host/)
#   Postgres           ks-shared-pg (flexible server, Postgres 17, `vector` allowed) with database ks_control and the
#                      roles ks_control_owner (KS-Ops writes the registry) and ks_control_reader (the apps read it)
#   Storage            ksshared<suffix>, private blob container `sites` (sites/<code>/portal, sites/<code>/client)
#
# Each brokerage after that is set up by KS-Ops on /ops/provisioning (its database ks_<code>, its role, its registry
# entry, its web builds): nothing in Azure is created per brokerage. See docs/PROVISIONING.md.
#
# Usage:
#   az login && az account set -s <Keystone subscription>
#   KS_OPS_APP=ks-ops KS_OPS_RG=<ks-ops resource group> scripts/provision-shared.sh
#
# Optional environment:
#   REGION            default canadacentral
#   STORAGE_SUFFIX    the storage account is ksshared<suffix> (lowercase letters and digits; the full name must be unique
#                     in Azure). Default: the existing ksshared* account in ks-shared, or 6 random characters.
#   APP_SKU           App Service plan size (default P0v3; Basic B1 or higher is needed for custom domains)
#   PG_TIER, PG_SKU   Postgres size (default Burstable / Standard_B2s)
#   PG_ADMIN_PASSWORD the Postgres admin password. Needed again on a re-run (it is not stored anywhere Azure can show
#                     it back) to update the ks_control roles; without it those steps are skipped and the script says so.
#   KS_OPS_APP, KS_OPS_RG   the KS-Ops App Service. With them: its outbound addresses are allowed on Postgres, and the
#                     KS-Ops settings below are written straight to it (nothing secret is printed).
#   OPENAI_API_KEY, SENDGRID_API_KEY, AZURE_STORAGE_CONNECTION_STRING   Keystone-wide settings for the shared server
#                     (and OPENAI_API_KEY for the agent), written when given.
#   ALLOW_MY_IP=1     allow this machine's public address on Postgres while the script runs (removed at the end), so
#                     psql can make the roles. Otherwise run it from somewhere already allowed.
#   CREATE_DEPLOY_SP=1  also create the service principal ks-shared-deploy (Website Contributor on ks-shared) for the
#                     secret AZURE_CREDENTIALS in the GitHub environment ks-shared of KS-server, KS-Agent and KS-Ops (printed once, in the COPY THIS NOW block).
#
# Requires: az (signed in), psql, openssl, curl. No extension other than `vector` is ever allowed or made.
set -euo pipefail

REGION="${REGION:-canadacentral}"
RG="ks-shared"
PLAN="ks-shared-plan"
SERVER_APP="ks-shared-server"
AGENT_APP="ks-shared-agent"
WEB_APP="ks-shared-web"
PG="ks-shared-pg"
PG_ADMIN="ksadmin"
CONTROL_DB="ks_control"
APP_SKU="${APP_SKU:-P0v3}"
PG_TIER="${PG_TIER:-Burstable}"
PG_SKU="${PG_SKU:-Standard_B2s}"
NODE_RUNTIME="${NODE_RUNTIME:-NODE:22-lts}"

command -v az >/dev/null || { echo "Azure CLI (az) is required." >&2; exit 2; }
command -v psql >/dev/null || { echo "psql is required (it makes the ks_control roles)." >&2; exit 2; }
command -v openssl >/dev/null || { echo "openssl is required." >&2; exit 2; }
az account show >/dev/null 2>&1 || { echo "Sign in first: az login" >&2; exit 2; }

say() { printf '\n==> %s\n' "$*"; }
exists() { "$@" --only-show-errors >/dev/null 2>&1; }
secret() { openssl rand -hex "${1:-32}"; }
setting() { # setting <app> <name> -> current value or empty
  az webapp config appsettings list -g "$RG" -n "$1" --query "[?name=='$2'].value | [0]" -o tsv --only-show-errors 2>/dev/null || true
}
urlenc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }

say "Resource group $RG ($REGION)"
if exists az group show -n "$RG"; then echo "exists"; else
  az group create -n "$RG" -l "$REGION" --tags keystone-shared=true --only-show-errors -o none
fi

say "App Service plan $PLAN ($APP_SKU, Linux)"
if exists az appservice plan show -g "$RG" -n "$PLAN"; then echo "exists"; else
  az appservice plan create -g "$RG" -n "$PLAN" -l "$REGION" --is-linux --sku "$APP_SKU" --only-show-errors -o none
fi

for APP in "$SERVER_APP" "$AGENT_APP" "$WEB_APP"; do
  say "Web app $APP ($NODE_RUNTIME)"
  if exists az webapp show -g "$RG" -n "$APP"; then echo "exists"; else
    az webapp create -g "$RG" -p "$PLAN" -n "$APP" --runtime "$NODE_RUNTIME" --only-show-errors -o none
  fi
  az webapp config set -g "$RG" -n "$APP" --startup-file "node dist/index.js" --always-on true \
    --http20-enabled true --min-tls-version 1.2 --only-show-errors -o none
  az webapp update -g "$RG" -n "$APP" --https-only true --only-show-errors -o none
done
SERVER_URL="https://$(az webapp show -g "$RG" -n "$SERVER_APP" --query defaultHostName -o tsv)"
AGENT_URL="https://$(az webapp show -g "$RG" -n "$AGENT_APP" --query defaultHostName -o tsv)"
WEB_URL="https://$(az webapp show -g "$RG" -n "$WEB_APP" --query defaultHostName -o tsv)"

say "Storage account and the private container 'sites'"
STORAGE="$(az storage account list -g "$RG" --query "[?starts_with(name, 'ksshared')].name | [0]" -o tsv --only-show-errors 2>/dev/null || true)"
if [[ -z "$STORAGE" ]]; then
  SUFFIX="${STORAGE_SUFFIX:-$(openssl rand -hex 3)}"
  STORAGE="ksshared${SUFFIX}"
  if ! [[ "$STORAGE" =~ ^[a-z0-9]{3,24}$ ]]; then echo "Storage account name $STORAGE is not valid (3-24 lowercase letters and digits)." >&2; exit 2; fi
  az storage account create -g "$RG" -n "$STORAGE" -l "$REGION" --sku Standard_LRS --kind StorageV2 \
    --min-tls-version TLS1_2 --allow-blob-public-access false --https-only true --only-show-errors -o none
else
  echo "exists: $STORAGE"
fi
SITES_CONN="$(az storage account show-connection-string -g "$RG" -n "$STORAGE" --query connectionString -o tsv)"
az storage container create --name sites --connection-string "$SITES_CONN" --public-access off --only-show-errors -o none

say "Postgres flexible server $PG (Postgres 17)"
if exists az postgres flexible-server show -g "$RG" -n "$PG"; then
  echo "exists"
  if [[ -z "${PG_ADMIN_PASSWORD:-}" ]]; then
    echo "PG_ADMIN_PASSWORD is not set: the ks_control roles and grants are not checked on this run." >&2
  fi
else
  PG_ADMIN_PASSWORD="${PG_ADMIN_PASSWORD:-$(secret 24)}"
  NEW_PG_PASSWORD=1
  az postgres flexible-server create -g "$RG" -n "$PG" -l "$REGION" \
    --tier "$PG_TIER" --sku-name "$PG_SKU" --storage-size 64 --version 17 \
    --admin-user "$PG_ADMIN" --admin-password "$PG_ADMIN_PASSWORD" \
    --public-access None --yes --only-show-errors -o none
fi
PG_HOST="$(az postgres flexible-server show -g "$RG" -n "$PG" --query fullyQualifiedDomainName -o tsv)"
# The only extension Keystone uses.
az postgres flexible-server parameter set -g "$RG" -s "$PG" --name azure.extensions --value VECTOR --only-show-errors -o none
if exists az postgres flexible-server db show -g "$RG" -s "$PG" -d "$CONTROL_DB"; then echo "database $CONTROL_DB exists"; else
  az postgres flexible-server db create -g "$RG" -s "$PG" -d "$CONTROL_DB" --only-show-errors -o none
fi

say "Postgres firewall: the shared apps and KS-Ops only"
ips_of() { az webapp show -g "$1" -n "$2" --query possibleOutboundIpAddresses -o tsv | tr ',' '\n' | sed 's/[[:space:]]//g' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true; }
all_ips() {
  ips_of "$RG" "$SERVER_APP"; ips_of "$RG" "$AGENT_APP"; ips_of "$RG" "$WEB_APP"
  if [[ -n "${KS_OPS_APP:-}" && -n "${KS_OPS_RG:-}" ]]; then ips_of "$KS_OPS_RG" "$KS_OPS_APP"; fi
}
APP_IPS="$(all_ips | sort -u)"
[[ -n "$APP_IPS" ]] || { echo "Could not read the apps' outbound addresses." >&2; exit 1; }
[[ -n "${KS_OPS_APP:-}" && -n "${KS_OPS_RG:-}" ]] || echo "Note: KS_OPS_APP / KS_OPS_RG not given, so KS-Ops's outbound addresses are not allowed yet (it needs Postgres to set up brokerages)."
while read -r IP; do
  [[ -n "$IP" ]] || continue
  az postgres flexible-server firewall-rule create -g "$RG" -n "$PG" --rule-name "ks-app-${IP//./-}" \
    --start-ip-address "$IP" --end-ip-address "$IP" --only-show-errors -o none
done <<<"$APP_IPS"
for RULE in $(az postgres flexible-server firewall-rule list -g "$RG" -n "$PG" --query "[].name" -o tsv --only-show-errors); do
  if [[ "$RULE" == ks-app-* ]] && ! grep -qx "${RULE#ks-app-}" <<<"$(tr '.' '-' <<<"$APP_IPS")"; then
    az postgres flexible-server firewall-rule delete -g "$RG" -n "$PG" --rule-name "$RULE" --yes --only-show-errors -o none
    echo "removed rule $RULE"
  elif [[ "$RULE" != ks-app-* && "$RULE" != ks-operator ]]; then
    az postgres flexible-server firewall-rule delete -g "$RG" -n "$PG" --rule-name "$RULE" --yes --only-show-errors -o none
    echo "removed rule $RULE"
  fi
done
if [[ "${ALLOW_MY_IP:-}" == "1" ]]; then
  MY_IP="$(curl -fsS https://api.ipify.org)"
  az postgres flexible-server firewall-rule create -g "$RG" -n "$PG" --rule-name ks-operator \
    --start-ip-address "$MY_IP" --end-ip-address "$MY_IP" --only-show-errors -o none
  trap 'az postgres flexible-server firewall-rule delete -g "$RG" -n "$PG" --rule-name ks-operator --yes --only-show-errors -o none || true' EXIT
  echo "allowed this machine ($MY_IP) until the script ends"
fi

# The keys the shared apps and KS-Ops share: made once, then kept (read back from the shared server's settings).
KS_TENANT_KEY="$(setting "$SERVER_APP" KS_TENANT_KEY)"; [[ -n "$KS_TENANT_KEY" ]] || KS_TENANT_KEY="$(secret 32)"
KS_OPS_SERVICE_KEY="$(setting "$SERVER_APP" KS_OPS_SERVICE_KEY)"; [[ -n "$KS_OPS_SERVICE_KEY" ]] || KS_OPS_SERVICE_KEY="$(secret 32)"
READER_URL="$(setting "$SERVER_APP" KS_CONTROL_DATABASE_URL)"
OWNER_URL=""

ADMIN_URL=""
if [[ -n "${PG_ADMIN_PASSWORD:-}" ]]; then
  ADMIN_URL="postgresql://${PG_ADMIN}:$(urlenc "$PG_ADMIN_PASSWORD")@${PG_HOST}:5432/postgres?sslmode=require"
  CONTROL_ADMIN_URL="postgresql://${PG_ADMIN}:$(urlenc "$PG_ADMIN_PASSWORD")@${PG_HOST}:5432/${CONTROL_DB}?sslmode=require"
  say "ks_control roles (owner writes the registry, reader only reads it)"
  role_exists() { [[ "$(psql "$ADMIN_URL" -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$1'")" == "1" ]]; }
  OWNER_PW="$(secret 24)"
  if role_exists ks_control_owner && [[ -z "${RESET_CONTROL_PASSWORDS:-}" ]]; then
    echo "ks_control_owner exists (its password is kept; RESET_CONTROL_PASSWORDS=1 makes a new one)"
    OWNER_PW=""
  else
    psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -v pw="$OWNER_PW" <<'SQL'
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ks_control_owner') AS found \gset owner_
\if :owner_found
ALTER ROLE ks_control_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'pw';
\else
CREATE ROLE ks_control_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'pw';
\endif
SQL
    OWNER_URL="postgresql://ks_control_owner:${OWNER_PW}@${PG_HOST}:5432/${CONTROL_DB}?sslmode=require"
  fi
  if [[ -z "$READER_URL" || -n "${RESET_CONTROL_PASSWORDS:-}" ]] || ! role_exists ks_control_reader; then
    READER_PW="$(secret 24)"
    psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -v pw="$READER_PW" <<'SQL'
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ks_control_reader') AS found \gset reader_
\if :reader_found
ALTER ROLE ks_control_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'pw';
\else
CREATE ROLE ks_control_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'pw';
\endif
SQL
    READER_URL="postgresql://ks_control_reader:${READER_PW}@${PG_HOST}:5432/${CONTROL_DB}?sslmode=require"
  fi
  # Only the two control roles may connect to ks_control; the owner may create the registry table in it.
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q <<SQL
REVOKE ALL ON DATABASE ${CONTROL_DB} FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE ${CONTROL_DB} TO ks_control_owner;
GRANT CONNECT ON DATABASE ${CONTROL_DB} TO ks_control_reader;
SQL
  psql "$CONTROL_ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "GRANT USAGE, CREATE ON SCHEMA public TO ks_control_owner;"
  if [[ -n "$OWNER_URL" ]]; then
    # The registry table now, as the owner (KS-Ops applies the same idempotent file again on startup and records it).
    psql "$OWNER_URL" -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/../migrations-control/001_ks_tenants.sql"
    echo "ks_tenants ready"
  fi
fi

say "App settings on the shared apps"
COMMON=("NODE_ENV=production" "SCM_DO_BUILD_DURING_DEPLOYMENT=false")
SERVER_SETTINGS=("${COMMON[@]}" "KS_TENANT_KEY=$KS_TENANT_KEY" "KS_OPS_SERVICE_KEY=$KS_OPS_SERVICE_KEY")
AGENT_SETTINGS=("${COMMON[@]}" "KS_TENANT_KEY=$KS_TENANT_KEY" "SERVER_URL=$SERVER_URL")
WEB_SETTINGS=("${COMMON[@]}" "KS_SITES_STORAGE_CONNECTION_STRING=$SITES_CONN")
if [[ -n "$READER_URL" ]]; then
  SERVER_SETTINGS+=("KS_CONTROL_DATABASE_URL=$READER_URL")
  AGENT_SETTINGS+=("KS_CONTROL_DATABASE_URL=$READER_URL")
  WEB_SETTINGS+=("KS_CONTROL_DATABASE_URL=$READER_URL")
else
  echo "Note: no ks_control_reader address yet (run again with PG_ADMIN_PASSWORD): KS_CONTROL_DATABASE_URL not written." >&2
fi
[[ -n "${OPENAI_API_KEY:-}" ]] && SERVER_SETTINGS+=("OPENAI_API_KEY=$OPENAI_API_KEY") && AGENT_SETTINGS+=("OPENAI_API_KEY=$OPENAI_API_KEY")
[[ -n "${SENDGRID_API_KEY:-}" ]] && SERVER_SETTINGS+=("SENDGRID_API_KEY=$SENDGRID_API_KEY")
[[ -n "${AZURE_STORAGE_CONNECTION_STRING:-}" ]] && SERVER_SETTINGS+=("AZURE_STORAGE_CONNECTION_STRING=$AZURE_STORAGE_CONNECTION_STRING")
az webapp config appsettings set -g "$RG" -n "$SERVER_APP" --settings "${SERVER_SETTINGS[@]}" --only-show-errors -o none
az webapp config appsettings set -g "$RG" -n "$AGENT_APP" --settings "${AGENT_SETTINGS[@]}" --only-show-errors -o none
az webapp config appsettings set -g "$RG" -n "$WEB_APP" --settings "${WEB_SETTINGS[@]}" --only-show-errors -o none
echo "saved"

KS_OPS_SETTINGS=(
  "KS_TENANT_KEY=$KS_TENANT_KEY"
  "KS_OPS_SERVICE_KEY=$KS_OPS_SERVICE_KEY"
  "KS_SHARED_SERVER_URL=$SERVER_URL"
  "KS_SHARED_AGENT_URL=$AGENT_URL"
  "KS_SITES_STORAGE_CONNECTION_STRING=$SITES_CONN"
)
[[ -n "$OWNER_URL" ]] && KS_OPS_SETTINGS+=("KS_CONTROL_OWNER_DATABASE_URL=$OWNER_URL")
[[ -n "$ADMIN_URL" ]] && KS_OPS_SETTINGS+=("KS_SHARED_PG_ADMIN_URL=$ADMIN_URL")
WROTE_KS_OPS=""
if [[ -n "${KS_OPS_APP:-}" && -n "${KS_OPS_RG:-}" ]]; then
  say "KS-Ops settings on $KS_OPS_APP"
  az webapp config appsettings set -g "$KS_OPS_RG" -n "$KS_OPS_APP" --settings "${KS_OPS_SETTINGS[@]}" --only-show-errors -o none
  WROTE_KS_OPS=1
  echo "saved ${#KS_OPS_SETTINGS[@]} settings (restart KS-Ops to pick them up)"
fi

DEPLOY_CREDS=""
if [[ "${CREATE_DEPLOY_SP:-}" == "1" ]]; then
  say "Deploy service principal ks-shared-deploy (Website Contributor on $RG only)"
  DEPLOY_CREDS="$(az ad sp create-for-rbac --name ks-shared-deploy --role "Website Contributor" \
    --scopes "$(az group show -n "$RG" --query id -o tsv)" --json-auth --only-show-errors)"
fi

cat <<SUMMARY

==================================================================================================
Keystone shared hosting is ready in resource group $RG.

  KS-server (shared)   $SERVER_URL      (App Service $SERVER_APP)
  KS-Agent (shared)    $AGENT_URL       (App Service $AGENT_APP)
  Web host             $WEB_URL         (App Service $WEB_APP; deploys from KS-Ops web-host/)
  Postgres             $PG_HOST, database $CONTROL_DB (registry), admin $PG_ADMIN
  Storage              $STORAGE, container sites

Next (docs/PROVISIONING.md, "What Todd sets up once"):
  - KS-server and KS-Agent repositories: deploy once to $SERVER_APP / $AGENT_APP (no per-brokerage matrix).
  - KS-Portal and KS-Client repositories: repository secret KS_SITES_STORAGE_CONNECTION_STRING (below).
  - KS-server, KS-Agent and KS-Ops: GitHub environment ks-shared, secret AZURE_CREDENTIALS (below, with CREATE_DEPLOY_SP=1) for the web host deploy.
  - KS-Ops app setting KS_DOMAIN = Keystone's domain for brokerage addresses (<code>.api.<domain> and so on).
SUMMARY
[[ -n "${NEW_PG_PASSWORD:-}" || -n "$OWNER_URL" || -z "$WROTE_KS_OPS" || -n "$DEPLOY_CREDS" ]] || exit 0

cat <<SECRETS

------------------------------------ COPY THIS NOW ------------------------------------------------
Shown once. Run the script again to make the role passwords again (RESET_CONTROL_PASSWORDS=1).
SECRETS
[[ -n "${NEW_PG_PASSWORD:-}" ]] && echo "  Postgres admin password ($PG_ADMIN): $PG_ADMIN_PASSWORD   (keep it in the password manager)"
if [[ -z "$WROTE_KS_OPS" ]]; then
  echo "  KS-Ops app settings:"
  for S in "${KS_OPS_SETTINGS[@]}"; do echo "    $S"; done
fi
echo "  KS-Portal and KS-Client repository secret:"
echo "    KS_SITES_STORAGE_CONNECTION_STRING=$SITES_CONN"
if [[ -n "$DEPLOY_CREDS" ]]; then
  echo "  GitHub environment ks-shared secret AZURE_CREDENTIALS (KS-server, KS-Agent, KS-Ops) ="
  echo "$DEPLOY_CREDS" | sed 's/^/    /'
fi
echo "---------------------------------------------------------------------------------------------------"
