import { json } from "../../http/http";
import { localResponseTimeFields } from "../../shared/time-provenance";
import { buildStrategyDashboard } from "./strategy-dashboard";
import { buildStrategyExperimentReport } from "./strategy-report";
import type { StrategyRouteContext } from "./strategy-route-context";

/** Owns strategy-run reporting, evidence, and single-run manual tick endpoints. */
export async function handleStrategyReportingRequest(
  request: Request,
  url: URL,
  context: StrategyRouteContext,
): Promise<Response | null> {
  const { store, runtime, actor, allow } = context;
  const strategyReportMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/report$/,
  );
  if (strategyReportMatch && request.method === "GET") {
    const runId = decodeURIComponent(strategyReportMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    const orders = await runtime.reconcileOrders(runId);
    const decisions = store.strategyDecisions(runId, 500);
    const traces = decisions
      .map((decision) => store.getStrategyDecisionTrace(decision.traceId))
      .filter(Boolean);
    const attribution = await runtime.buildAttribution(run, orders);
    const performance = await runtime.buildPerformance(run, orders);
    const report = buildStrategyExperimentReport({
      run,
      decisions,
      traces: traces as any[],
      orders,
      metrics: store.strategyMetrics(runId) as any[],
      notes: store.strategyNotes(runId) as any[],
      attribution,
      performance,
      executionReplay: (attribution as any).executionReplay,
      auditTrail: store.strategyAuditTrail(runId),
      auditVerification: store.verifyStrategyAuditTrail(runId),
    });
    return json(report);
  }
  const strategyAuditMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/audit$/,
  );
  if (strategyAuditMatch && request.method === "GET") {
    const runId = decodeURIComponent(strategyAuditMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    return json({
      runId,
      auditTrail: store.strategyAuditTrail(runId),
      verification: store.verifyStrategyAuditTrail(runId),
      ...localResponseTimeFields(new Date()),
    });
  }
  const strategyDashboardMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/dashboard$/,
  );
  if (strategyDashboardMatch && request.method === "GET") {
    const runId = decodeURIComponent(strategyDashboardMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    const orders = await runtime.reconcileOrders(runId);
    const decisions = store.strategyDecisions(runId, 500);
    const traces = decisions
      .map((decision) => store.getStrategyDecisionTrace(decision.traceId))
      .filter(Boolean);
    const retrievedAt = new Date().toISOString();
    const serverRespondedAt = new Date().toISOString();
    return json(
      buildStrategyDashboard({
        run,
        decisions,
        traces: traces as any[],
        orders,
        retrievedAt,
        serverRespondedAt,
      }),
    );
  }
  const strategyAttributionMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/attribution$/,
  );
  if (strategyAttributionMatch && request.method === "GET") {
    const runId = decodeURIComponent(strategyAttributionMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    return json(
      await runtime.buildAttribution(run, await runtime.reconcileOrders(runId)),
    );
  }
  const strategyPerformanceMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/performance$/,
  );
  if (strategyPerformanceMatch && request.method === "GET") {
    const runId = decodeURIComponent(strategyPerformanceMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    return json(
      await runtime.buildPerformance(run, await runtime.reconcileOrders(runId)),
    );
  }
  const strategyAlertsMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/alerts$/,
  );
  if (strategyAlertsMatch && request.method === "GET") {
    const runId = decodeURIComponent(strategyAlertsMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    return json(await runtime.buildAlerts(run));
  }
  const strategyRunDecisionMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/decisions$/,
  );
  if (strategyRunDecisionMatch && request.method === "GET") {
    const runId = decodeURIComponent(strategyRunDecisionMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const decision = url.searchParams.get("decision") as any;
    const filters = {
      symbol: url.searchParams.get("symbol"),
      decision: decision || null,
      strategyVersion: url.searchParams.get("strategyVersion"),
      blockReason: url.searchParams.get("blockReason"),
      orderOutcome: url.searchParams.get("orderOutcome"),
    };
    return json({
      runId,
      filters,
      decisions: store.strategyDecisions(runId, limit, filters),
      ...localResponseTimeFields(new Date()),
    });
  }
  const strategyRunTickMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/tick$/,
  );
  if (strategyRunTickMatch && request.method === "POST") {
    if (!allow(`${actor}:strategy-tick`, 30))
      return json({ error: "Strategy tick rate limit exceeded" }, 429);
    const runId = decodeURIComponent(strategyRunTickMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    return json(await runtime.evaluateRun(run, actor, "manual"));
  }
  const strategyTraceMatch = url.pathname.match(
    /^\/api\/strategy\/decision-traces\/([^/]+)$/,
  );
  if (strategyTraceMatch && request.method === "GET") {
    const trace = store.getStrategyDecisionTrace(
      decodeURIComponent(strategyTraceMatch[1]!),
    );
    return trace
      ? json(trace)
      : json({ error: "Strategy decision trace not found" }, 404);
  }

  return null;
}
