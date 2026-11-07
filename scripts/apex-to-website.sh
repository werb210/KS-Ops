#!/usr/bin/env bash
# KS_DNS_AZURE_v1 - send the bare domain (keystonecrm.online, no www) to the Keystone website.
#
# GoDaddy's two A records only pointed at its parking servers (404). Run this AFTER scripts/dns-zone-setup.sh and the
# nameserver switch at GoDaddy (the website checks a TXT record over public DNS). It points the apex at the website's
# Static Web App with an Azure DNS alias record and adds keystonecrm.online as a custom domain there (free certificate).
# Safe to run again.
set -euo pipefail

RG=${RG:-ks-shared}
ZONE=keystonecrm.online
SWA_RG=${SWA_RG:-ks-dev}
SWA=${SWA:-ks-website-dev}

SWA_ID=$(az staticwebapp show -g "$SWA_RG" -n "$SWA" --query id -o tsv)

# The alias replaces GoDaddy's parking addresses.
az network dns record-set a delete -g "$RG" -z "$ZONE" -n @ --yes -o none 2>/dev/null || true
az network dns record-set a create -g "$RG" -z "$ZONE" -n @ --target-resource "$SWA_ID" -o none
echo "ok A @ -> $SWA (alias)"

if ! az staticwebapp hostname list -g "$SWA_RG" -n "$SWA" --query "[?name=='$ZONE'].name" -o tsv | grep -qx "$ZONE"; then
  az staticwebapp hostname set -g "$SWA_RG" -n "$SWA" --hostname "$ZONE" --validation-method dns-txt-token --no-wait -o none
  token=""
  for _ in $(seq 1 30); do
    token=$(az staticwebapp hostname show -g "$SWA_RG" -n "$SWA" --hostname "$ZONE" --query validationToken -o tsv 2>/dev/null || true)
    [ -n "$token" ] && break
    sleep 10
  done
  [ -n "$token" ] || { echo "No validation token yet - run this script again in a few minutes."; exit 1; }
  az network dns record-set txt add-record -g "$RG" -z "$ZONE" -n @ -v "$token" -o none
  echo "ok TXT @ (website validation)"
fi
echo "The website checks the record and issues the certificate by itself (usually 5-15 minutes)."
echo DONE
