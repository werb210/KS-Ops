#!/usr/bin/env bash
# KS_WILDCARD_DOMAINS_v1 - one-time set-up so a new brokerage's addresses work with no per-brokerage step:
#   *.api.<domain>     -> ks-shared-server      (every brokerage's KS-server address)
#   *.portal.<domain>  -> ks-shared-web         (every brokerage's staff portal)
#   *.app.<domain>     -> ks-shared-web         (every brokerage's client app)
# It adds the wildcard CNAME and asuid TXT records in Azure DNS, binds the three wildcard host names on the apps,
# lets the deploy identity (ks-shared-deploy) answer certificate DNS challenges in the zone, and starts the
# "Wildcard certificate" workflow in KS-Ops, which issues a free Let's Encrypt certificate for all three and renews it
# every month by itself. Run once in Azure Cloud Shell (Keystone subscription, signed in to GitHub). Safe to run again.
set -euo pipefail

RG=${RG:-ks-shared}
ZONE=${KS_DOMAIN:-keystonecrm.online}
SERVER=ks-shared-server
WEB=ks-shared-web

az network dns zone show -g "$RG" -n "$ZONE" -o none || { echo "Azure DNS zone $ZONE not found: run scripts/dns-zone-setup.sh first."; exit 1; }

wild() { # wild <label> <app>
  local label=$1 app=$2 vid
  vid=$(az webapp show -g "$RG" -n "$app" --query customDomainVerificationId -o tsv)
  az network dns record-set cname show -g "$RG" -z "$ZONE" -n "*.$label" -o none 2>/dev/null \
    || az network dns record-set cname set-record -g "$RG" -z "$ZONE" -n "*.$label" -c "$app.azurewebsites.net" --ttl 3600 -o none
  az network dns record-set txt show -g "$RG" -z "$ZONE" -n "asuid.$label" -o none 2>/dev/null \
    || az network dns record-set txt add-record -g "$RG" -z "$ZONE" -n "asuid.$label" -v "$vid" -o none
  echo "  ok  dns  *.$label.$ZONE -> $app"
}

bind() { # bind <host> <app>
  local host=$1 app=$2 i
  if az webapp config hostname list -g "$RG" --webapp-name "$app" --query "[?name=='$host'].name" -o tsv | grep -qxF "$host"; then
    echo "  ok  host $host on $app (already)"; return
  fi
  for i in 1 2 3 4 5 6 7 8 9 10; do
    az webapp config hostname add -g "$RG" --webapp-name "$app" --hostname "$host" -o none 2>/dev/null && { echo "  ok  host $host on $app"; return; }
    sleep 30
  done
  echo "  !!  could not add $host to $app yet (public DNS not updated?) - run this script again in a few minutes"; return 1
}

echo "1/4 DNS records"
wild api "$SERVER"
wild portal "$WEB"
wild app "$WEB"

echo "2/4 Wildcard host names on the shared apps"
bind "*.api.$ZONE" "$SERVER"
bind "*.portal.$ZONE" "$WEB"
bind "*.app.$ZONE" "$WEB"

echo "3/4 Certificate renewals may answer DNS challenges in $ZONE"
SP=$(az ad sp list --display-name ks-shared-deploy --query "[0].id" -o tsv)
ZONE_ID=$(az network dns zone show -g "$RG" -n "$ZONE" --query id -o tsv)
if [ -n "$SP" ]; then
  az role assignment create --assignee-object-id "$SP" --assignee-principal-type ServicePrincipal --role "DNS Zone Contributor" --scope "$ZONE_ID" -o none 2>/dev/null || true
  echo "  ok  ks-shared-deploy: DNS Zone Contributor on $ZONE"
else
  echo "  !!  service principal ks-shared-deploy not found (run the deploy-keys step first)"; exit 1
fi

echo "4/4 First certificate (the workflow then renews it monthly)"
gh workflow run wildcard-cert.yml -R werb210/KS-Ops --ref main && echo "  ok  started: https://github.com/werb210/KS-Ops/actions/workflows/wildcard-cert.yml"
echo DONE
