import { ExternalLink } from "lucide-react";
import type { IntegrationKind } from "@founderos/shared";
import { INTEGRATION_CATALOG } from "@founderos/shared";
import { Button } from "@/components/ui/button";

type Props = {
  kind: IntegrationKind;
  companyId: string;
};

export function OAuthConnectButton({ kind, companyId }: Props) {
  const catalog = INTEGRATION_CATALOG[kind];

  function handleClick() {
    const returnUrl = "/integrations";
    const params = new URLSearchParams({ companyId, returnUrl });
    window.location.href = `/api/oauth/${kind}/start?${params.toString()}`;
  }

  return (
    <Button size="sm" className="w-full" onClick={handleClick}>
      <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
      Connect with {catalog.label}
    </Button>
  );
}
