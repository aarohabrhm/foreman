"use client";

import { useSession } from "@/components/SessionProvider";
import { ORG_USAGE } from "@/lib/graphql/operations";
import { useGraphQLSubscription } from "@/lib/hooks";

interface Usage {
  quota_allowed: number;
  quota_used: number;
  runs_remaining: number;
  runs_this_period: number;
  avg_run_seconds_this_period: number | null;
}

/**
 * Quota indicator, fed by the org_usage_current_period view over a subscription
 * so it moves as runs complete — the counter it shows is the same one the
 * engine increments and assertQuotaAvailable enforces against.
 */
export function UsageIndicator() {
  const { activeOrgId, role } = useSession();

  const { data } = useGraphQLSubscription<{ org_usage_current_period: Usage[] }>(
    ORG_USAGE,
    activeOrgId ? { orgId: activeOrgId } : null,
    role,
  );

  const usage = data?.org_usage_current_period?.[0];
  if (!usage) return null;

  const used = usage.quota_used;
  const allowed = usage.quota_allowed || 1;
  const percent = Math.min(100, Math.round((used / allowed) * 100));
  const exhausted = used >= usage.quota_allowed;

  return (
    <div
      className="hidden sm:block min-w-40"
      title={
        `${usage.runs_this_period} run(s) started this period` +
        (usage.avg_run_seconds_this_period
          ? `, averaging ${usage.avg_run_seconds_this_period.toFixed(1)}s`
          : "")
      }
    >
      <div className="flex items-baseline justify-between text-xs text-[var(--muted)]">
        <span>Quota</span>
        <span className={exhausted ? "text-red-500 font-medium" : ""}>
          {used}/{usage.quota_allowed}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <div
          className={`h-full rounded-full ${exhausted ? "bg-red-500" : "bg-blue-500"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
