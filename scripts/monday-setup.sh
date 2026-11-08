#!/usr/bin/env bash
# KS_MONDAY_SETUP_v1 - the owner-only settings for Keystone live testing, in one Cloud Shell paste:
#   1. GitHub sign-in (only if Cloud Shell is not signed in yet)
#   2. KS-Ops may start the GitHub part of each brokerage set-up (KS_PROVISION_GITHUB_TOKEN + KS_PROVISION_GH_TOKEN)
#   3. Twilio master account for brokerage sub-accounts = Boreal's main Twilio account (KS_TWILIO_ACCOUNT_SID/_AUTH_TOKEN)
#   4. Google sign-in client secret (asked for, hidden) - press Enter on an empty line to skip
#   5. keystonecrm.online DNS copied into Azure DNS (scripts/dns-zone-setup.sh), nameservers printed for GoDaddy
# Secrets go straight from one Azure/GitHub setting to another and are never printed.
set -uo pipefail

APP_RG=ks-dev
APP=ks-ops-dev
GOOGLE_CLIENT_ID=504925293846-fv991jisb437tuus2tgj5uifc6f9cb73.apps.googleusercontent.com
ok() { echo "  OK  $*"; }
bad() { echo "  !!  $*"; }

echo "1/5 GitHub sign-in"
if ! gh auth status >/dev/null 2>&1; then
  echo "    Follow the prompts: answer Y, then enter the code shown at https://github.com/login/device"
  gh auth login --hostname github.com --git-protocol https --web --scopes 'repo,workflow' || bad "GitHub sign-in did not finish"
fi
gh auth status >/dev/null 2>&1 && ok "GitHub signed in"

echo "2/5 GitHub access for KS-Ops"
if gh auth status >/dev/null 2>&1; then
  T=$(gh auth token)
  az webapp config appsettings set -g "$APP_RG" -n "$APP" --settings KS_PROVISION_GITHUB_TOKEN="$T" -o none \
    && gh api -X PUT repos/werb210/KS-Ops/environments/ks-ops-provisioning >/dev/null \
    && printf %s "$T" | gh secret set KS_PROVISION_GH_TOKEN -R werb210/KS-Ops -e ks-ops-provisioning >/dev/null \
    && ok "KS-Ops can start brokerage set-ups on GitHub" || bad "GitHub access step failed"
  unset T
else
  bad "skipped (not signed in to GitHub)"
fi

echo "3/5 Twilio master account (Boreal main account, for testing)"
g() { az webapp config appsettings list -g boreal-financial-rg -n boreal-staff-server --query "[?name=='$1'].value" -o tsv; }
S=$(g TWILIO_ACCOUNT_SID); K=$(g TWILIO_AUTH_TOKEN)
if [ -n "$S" ] && [ -n "$K" ]; then
  az webapp config appsettings set -g "$APP_RG" -n "$APP" --settings KS_TWILIO_ACCOUNT_SID="$S" KS_TWILIO_AUTH_TOKEN="$K" -o none \
    && ok "Twilio master set" || bad "Twilio step failed"
else
  bad "Boreal Twilio settings not found"
fi
unset S K

echo "4/5 Google sign-in secret"
echo "    Copy the secret from Google Cloud > Keystone CRM > Clients > Keystone servers > Client secrets."
GS=""
while [ -z "$GS" ]; do read -rsp "    Paste it here and press Enter (nothing shows; type skip to skip): " GS; echo; done
if [ "$GS" != "skip" ]; then
  az webapp config appsettings set -g "$APP_RG" -n "$APP" --settings KS_GOOGLE_OAUTH_CLIENT_ID="$GOOGLE_CLIENT_ID" KS_GOOGLE_OAUTH_CLIENT_SECRET="$GS" -o none \
    && ok "Google secret saved (length ${#GS})" || bad "Google step failed"
else
  bad "skipped - run this script again later to add it"
fi
unset GS

echo "5/5 DNS for keystonecrm.online"
gh api repos/werb210/KS-Ops/contents/scripts/dns-zone-setup.sh -q .content 2>/dev/null | base64 -d > /tmp/dns.sh \
  || curl -fsSL https://raw.githubusercontent.com/werb210/KS-Ops/main/scripts/dns-zone-setup.sh -o /tmp/dns.sh
bash /tmp/dns.sh || bad "DNS step failed"

echo
echo "Last step: GoDaddy > keystonecrm.online > DNS > Nameservers > Change > I'll use my own nameservers,"
echo "enter the four nameservers above and Save. Then tell Claude 'done'."
