#!/usr/bin/env bash
# KS_DNS_AZURE_v1 - connect one brokerage's three addresses to the shared apps, in one command:
#   <code>.api.keystonecrm.online     -> ks-shared-server
#   <code>.portal.keystonecrm.online  -> ks-shared-web
#   <code>.app.keystonecrm.online     -> ks-shared-web
# For each: the CNAME and asuid TXT records in Azure DNS (scripts/dns-zone-setup.sh made the zone), the host name on
# the app, a free App Service managed certificate, and the SNI binding. This is what the custom_domains provisioning
# step on /ops/provisioning lists; that step checks every 15 minutes and finishes by itself once all three answer.
#
# Usage (Azure Cloud Shell, Keystone subscription):   bash bind-brokerage-domains.sh <company code>
# Safe to run again: each part is skipped when it is already there.
set -euo pipefail

CODE=${1:-}
[[ "$CODE" =~ ^[a-z0-9][a-z0-9-]{0,29}[a-z0-9]$ ]] || { echo "Usage: $0 <company code> (lowercase letters, numbers, hyphens)"; exit 1; }

RG=${RG:-ks-shared}
ZONE=${KS_DOMAIN:-keystonecrm.online}
TTL=3600

bind_one() { # bind_one <label under the zone> <app>
  local label=$1 app=$2 host="$1.$ZONE"
  local vid
  vid=$(az webapp show -g "$RG" -n "$app" --query customDomainVerificationId -o tsv)

  az network dns record-set cname show -g "$RG" -z "$ZONE" -n "$label" -o none 2>/dev/null \
    || az network dns record-set cname set-record -g "$RG" -z "$ZONE" -n "$label" -c "$app.azurewebsites.net" --ttl $TTL -o none
  az network dns record-set txt show -g "$RG" -z "$ZONE" -n "asuid.$label" -o none 2>/dev/null \
    || az network dns record-set txt add-record -g "$RG" -z "$ZONE" -n "asuid.$label" -v "$vid" -o none
  echo "  dns     $host -> $app.azurewebsites.net"

  if ! az webapp config hostname list -g "$RG" --webapp-name "$app" --query "[?name=='$host'].name" -o tsv | grep -qx "$host"; then
    local i
    for i in 1 2 3 4 5 6; do # Azure checks the new records; give them a moment to be visible
      az webapp config hostname add -g "$RG" --webapp-name "$app" --hostname "$host" -o none 2>/dev/null && break
      [ "$i" = 6 ] && { echo "  FAILED  adding $host to $app (DNS not visible yet?) - run this command again in a few minutes"; return 1; }
      sleep 20
    done
  fi
  echo "  host    $host on $app"

  local thumb
  thumb=$(az webapp config ssl list -g "$RG" --query "[?subjectName=='$host'].thumbprint | [0]" -o tsv)
  if [ -z "$thumb" ]; then
    az webapp config ssl create -g "$RG" -n "$app" --hostname "$host" -o none
    thumb=$(az webapp config ssl list -g "$RG" --query "[?subjectName=='$host'].thumbprint | [0]" -o tsv)
  fi
  az webapp config ssl bind -g "$RG" -n "$app" --ssl-type SNI --certificate-thumbprint "$thumb" --hostname "$host" -o none
  echo "  https   $host (certificate bound)"
}

echo "Brokerage $CODE"
bind_one "$CODE.api" ks-shared-server
bind_one "$CODE.portal" ks-shared-web
bind_one "$CODE.app" ks-shared-web
echo DONE
