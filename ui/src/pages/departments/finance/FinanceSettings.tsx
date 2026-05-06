import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CURRENCY_CODES } from "@founderos/shared";
import { Save, AlertCircle, CheckCircle2 } from "lucide-react";
import { financeSettingsApi } from "@/api/finance-settings";
import { queryKeys } from "../../../lib/queryKeys";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { cn } from "../../../lib/utils";

interface FinanceSettingsProps {
  companyId: string;
}

/**
 * Finance settings — manual inputs (S5.9).
 *
 * Founder enters cash on hand and monthly burn (and currency). These power
 * S5.5 runway forecast + S5.8 cash planning. Cents are converted to/from
 * dollars on the boundary; the input is in whole-currency units for human
 * legibility but the wire format is integer cents.
 */
export function FinanceSettings({ companyId }: FinanceSettingsProps) {
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: queryKeys.finance.settings(companyId),
    queryFn: () => financeSettingsApi.get(companyId),
  });

  const [cashDollars, setCashDollars] = useState<string>("");
  const [burnDollars, setBurnDollars] = useState<string>("");
  const [currency, setCurrency] = useState<string>("USD");
  const [savedFlash, setSavedFlash] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Hydrate form when query resolves.
  useEffect(() => {
    if (!settingsQuery.data) return;
    setCashDollars(centsToDollars(settingsQuery.data.cashBalanceCents));
    setBurnDollars(centsToDollars(settingsQuery.data.monthlyBurnCents));
    setCurrency(settingsQuery.data.currency);
  }, [settingsQuery.data]);

  const upsertMutation = useMutation({
    mutationFn: () =>
      financeSettingsApi.upsert(companyId, {
        cashBalanceCents: dollarsToCents(cashDollars),
        monthlyBurnCents: dollarsToCents(burnDollars),
        currency: currency as (typeof CURRENCY_CODES)[number],
      }),
    onSuccess: async () => {
      setErrorMsg(null);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.finance.settings(companyId),
      });
    },
    onError: (error) => {
      setErrorMsg(error instanceof Error ? error.message : "Failed to save");
    },
  });

  const runwayMonths = computeRunwayMonths(
    dollarsToCents(cashDollars),
    dollarsToCents(burnDollars),
  );

  return (
    <div className="space-y-6 max-w-xl">
      <header>
        <h2 className="text-lg font-semibold">Finance settings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Cash on hand and monthly burn power runway forecasts and cash
          planning. We can't derive these from Stripe, so update them
          whenever you raise or change spending.
        </p>
      </header>

      <div className="space-y-4 rounded-lg border bg-card p-5">
        <FormField
          label="Cash on hand"
          hint="Total cash + cash equivalents you have today"
          symbol={currencySymbol(currency)}
        >
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={cashDollars}
            onChange={(e) => setCashDollars(e.target.value)}
            placeholder="100000"
            disabled={upsertMutation.isPending}
          />
        </FormField>

        <FormField
          label="Monthly burn"
          hint="Net cash out per month (salaries, infra, contractors, etc.)"
          symbol={currencySymbol(currency)}
        >
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={burnDollars}
            onChange={(e) => setBurnDollars(e.target.value)}
            placeholder="20000"
            disabled={upsertMutation.isPending}
          />
        </FormField>

        <div>
          <label
            htmlFor="finance-currency"
            className="text-sm font-medium block mb-1.5"
          >
            Currency
          </label>
          <select
            id="finance-currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            disabled={upsertMutation.isPending}
            className={cn(
              "w-full rounded-md border bg-background px-3 py-2 text-sm",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {CURRENCY_CODES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        {runwayMonths !== null && (
          <div className="rounded-md bg-muted px-3 py-2 text-sm">
            <span className="text-muted-foreground">Runway estimate: </span>
            <span className="font-semibold">
              {runwayMonths === Infinity
                ? "∞ (no burn)"
                : `${runwayMonths.toFixed(1)} months`}
            </span>
            <span className="text-muted-foreground ml-2 text-xs">
              (cash ÷ burn — does not yet account for revenue)
            </span>
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <Button
            onClick={() => upsertMutation.mutate()}
            disabled={
              upsertMutation.isPending ||
              !isPositiveNumber(cashDollars) ||
              !isPositiveNumber(burnDollars)
            }
          >
            <Save className="size-4 mr-2" />
            {upsertMutation.isPending ? "Saving…" : "Save"}
          </Button>

          {savedFlash && (
            <span className="flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-4" />
              Saved
            </span>
          )}

          {errorMsg && (
            <span className="flex items-center gap-1 text-sm text-destructive">
              <AlertCircle className="size-4" />
              {errorMsg}
            </span>
          )}
        </div>
      </div>

      {settingsQuery.data?.lastUpdatedAt && (
        <p className="text-xs text-muted-foreground">
          Last updated{" "}
          {new Date(settingsQuery.data.lastUpdatedAt).toLocaleString()}
          {settingsQuery.data.lastUpdatedBy
            ? ` by ${settingsQuery.data.lastUpdatedBy}`
            : ""}
        </p>
      )}
    </div>
  );
}

interface FormFieldProps {
  label: string;
  hint: string;
  symbol: string;
  children: React.ReactNode;
}

function FormField({ label, hint, symbol, children }: FormFieldProps) {
  return (
    <div>
      <label className="text-sm font-medium block mb-1.5">{label}</label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">
          {symbol}
        </span>
        <div className="pl-7">{children}</div>
      </div>
      <p className="text-xs text-muted-foreground mt-1">{hint}</p>
    </div>
  );
}

function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2).replace(/\.00$/, "");
}

function dollarsToCents(input: string): number {
  const parsed = parseFloat(input);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed * 100);
}

function isPositiveNumber(input: string): boolean {
  const v = parseFloat(input);
  return Number.isFinite(v) && v >= 0;
}

function currencySymbol(currency: string): string {
  switch (currency) {
    case "USD":
      return "$";
    case "EUR":
      return "€";
    case "GBP":
      return "£";
    case "INR":
      return "₹";
    default:
      return "$";
  }
}

function computeRunwayMonths(cashCents: number, burnCents: number): number | null {
  if (cashCents <= 0) return null;
  if (burnCents <= 0) return Infinity;
  return cashCents / burnCents;
}
