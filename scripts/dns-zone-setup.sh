#!/usr/bin/env bash
# KS_DNS_AZURE_v1 - one-time move of keystonecrm.online's DNS from GoDaddy to Azure DNS (zone in resource group ks-shared).
#
# Why: every brokerage on the shared server needs three addresses (<code>.api, <code>.portal, <code>.app under
# keystonecrm.online), each with a CNAME and an asuid TXT record. In Azure DNS, scripts/bind-brokerage-domains.sh adds
# them with one command per brokerage instead of six hand-made GoDaddy records.
#
# The zone is an exact copy of the GoDaddy records as of 2026-11-07 (website, Microsoft 365 mail, SendGrid, ops),
# so nothing changes for mail or the website when the nameservers move. Run it in Azure Cloud Shell (Keystone
# subscription). Safe to run again: records that already exist are left as they are.
#
# After it prints the four Azure nameservers: GoDaddy > keystonecrm.online > DNS > Nameservers > Change >
# "I'll use my own nameservers", enter the four, Save. Changes usually reach everyone within an hour.
set -euo pipefail

RG=${RG:-ks-shared}
ZONE=keystonecrm.online
TTL=3600

az network dns zone show -g "$RG" -n "$ZONE" -o none 2>/dev/null || az network dns zone create -g "$RG" -n "$ZONE" -o none

has() { # has <type> <name>
  az network dns record-set "$1" show -g "$RG" -z "$ZONE" -n "$2" -o none 2>/dev/null
}
cname() { has cname "$1" || az network dns record-set cname set-record -g "$RG" -z "$ZONE" -n "$1" -c "$2" --ttl $TTL -o none; echo "ok CNAME $1"; }
txt() { # txt <name> <value...>: only when the record set does not exist yet
  local name=$1; shift
  if ! has txt "$name"; then
    for v in "$@"; do az network dns record-set txt add-record -g "$RG" -z "$ZONE" -n "$name" -v "$v" -o none; done
  fi
  echo "ok TXT $name"
}

if ! has a @; then
  az network dns record-set a add-record -g "$RG" -z "$ZONE" -n @ -a 15.197.225.128 -o none
  az network dns record-set a add-record -g "$RG" -z "$ZONE" -n @ -a 3.33.251.168 -o none
fi
echo "ok A @"
has mx @ || az network dns record-set mx add-record -g "$RG" -z "$ZONE" -n @ -p 0 -e keystonecrm-online.mail.protection.outlook.com -o none
echo "ok MX @"
txt @ "MS=ms71071126" "v=spf1 include:spf.protection.outlook.com -all"
cname 53799175 sendgrid.net
cname autodiscover autodiscover.outlook.com
cname em5767 u53799175.wl176.sendgrid.net
cname ops ks-ops-dev.azurewebsites.net
cname s1._domainkey s1.domainkey.u53799175.wl176.sendgrid.net
cname s2._domainkey s2.domainkey.u53799175.wl176.sendgrid.net
cname url7188 click.sendgrid.net
cname www nice-field-065dae410.1.azurestaticapps.net
cname _acme-challenge.url7188 url7188.keystonecrm.online.4a767ed83ff78982.dcv.cloudflare.com
txt asuid.ops 569F60CCE802E4566463B2D82E716A748DAA990777F464F5A2E24B25AFF97119
txt _cf-custom-hostname.url7188 4af4da43-6f33-4995-bd57-66dd37c26a4f
txt _dmarc "v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;"

echo
echo "Azure nameservers for $ZONE (enter these four at GoDaddy > Nameservers > I'll use my own nameservers):"
az network dns zone show -g "$RG" -n "$ZONE" --query nameServers -o tsv | sed 's/\.$//'
echo DONE
