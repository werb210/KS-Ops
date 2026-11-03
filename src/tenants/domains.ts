// KS_SHARED_HOSTING_v1 - a brokerage's custom domains on the shared apps: its api host on ks-shared-server, its portal
// and client hosts on ks-shared-web, each with a free App Service managed certificate.
//
// KS-Ops holds no Azure credential (docs/AUTO_PROVISIONING.md: the power to change Azure lives only in GitHub
// Actions with a federated credential), so it does not call Azure here. It works out the exact DNS records and `az`
// commands, shows them on /ops/provisioning, and checks every 15 minutes whether each host answers over https with
// its own certificate. Once all of them do, the step is done by itself.
import { SHARED, type TenantHosts } from "./config.js";

export type DomainBinding = { host: string; app: string; kind: "api" | "portal" | "client" };

export function bindingsFor(hosts: TenantHosts): DomainBinding[] {
  return [
    ...hosts.api.map((host) => ({ host, app: SHARED.serverApp, kind: "api" as const })),
    ...hosts.portal.map((host) => ({ host, app: SHARED.webApp, kind: "portal" as const })),
    ...hosts.client.map((host) => ({ host, app: SHARED.webApp, kind: "client" as const })),
  ];
}

/** The DNS records to create at Keystone's DNS provider, in plain words. */
export function dnsRecords(bindings: DomainBinding[]): string[] {
  return bindings.flatMap((b) => [
    `CNAME  ${b.host}  ->  ${b.app}.azurewebsites.net`,
    `TXT    asuid.${b.host}  ->  the value printed by: az webapp show -g ${SHARED.resourceGroup} -n ${b.app} --query customDomainVerificationId -o tsv`,
  ]);
}

/** The exact commands, run once the DNS records exist (Azure checks them when the host name is added). */
export function azCommands(bindings: DomainBinding[]): string[] {
  const rg = SHARED.resourceGroup;
  return bindings.flatMap((b) => [
    `az webapp config hostname add -g ${rg} --webapp-name ${b.app} --hostname ${b.host}`,
    `az webapp config ssl create -g ${rg} -n ${b.app} --hostname ${b.host}`,
    `az webapp config ssl bind -g ${rg} -n ${b.app} --ssl-type SNI --hostname ${b.host} --certificate-thumbprint "$(az webapp config ssl show -g ${rg} --certificate-name ${b.host} --query thumbprint -o tsv)"`,
  ]);
}

/**
 * Asks each host over https. Any HTTP answer means the host name is bound with a valid certificate (an unbound host
 * fails the TLS check, because Azure presents its *.azurewebsites.net certificate). Returns the hosts not ready yet.
 */
export async function hostsNotReady(fetchImpl: typeof fetch, bindings: DomainBinding[]): Promise<Array<{ host: string; problem: string }>> {
  const out: Array<{ host: string; problem: string }> = [];
  await Promise.all(
    bindings.map(async (b) => {
      const path = b.kind === "api" ? "/health" : "/";
      try {
        const r = await fetchImpl(`https://${b.host}${path}`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });
        await r.text().catch(() => "");
        if (b.kind === "api" && r.status !== 200) out.push({ host: b.host, problem: `answered ${r.status}` });
      } catch (err) {
        out.push({ host: b.host, problem: err instanceof Error ? err.message : String(err) });
      }
    }),
  );
  return out.sort((a, b) => a.host.localeCompare(b.host));
}
