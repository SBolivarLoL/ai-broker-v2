import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import type { createStore } from "../../persistence/store";
import { managedOrderDto } from "../orders/order-management";
import { buildStrategyAlerts } from "./strategy-alerts";
import { buildStrategyOrderAttribution } from "./strategy-attribution";
import { buildStrategyExecutionReplay } from "./strategy-execution-replay";
import { buildStrategyPerformance } from "./strategy-performance";
import { buildStrategyErrorMetric, buildStrategySpan } from "./strategy-observability";

type Store = ReturnType<typeof createStore>;
type StrategyRunRecord = NonNullable<ReturnType<Store["getStrategyRun"]>>;

type StrategyMetricRow = {
  runId: string;
  name: string;
  value: number;
  unit: string;
  asOf: string;
};

type StrategyReportingDependencies = {
  alpaca: Alpaca;
  store: Store;
  recordMetricRows: (rows: StrategyMetricRow[]) => void;
  recordSpan: (
    actor: string,
    input: Parameters<typeof buildStrategySpan>[0],
  ) => void;
};

/** Owns strategy order reconciliation, attribution, performance, and alert reporting. */
export function createStrategyReporting({
  alpaca,
  store,
  recordMetricRows,
  recordSpan,
}: StrategyReportingDependencies) {
  function recordStrategyOrderMetrics(
    runId: string,
    orders: { status: string; payload: any }[],
    asOf = new Date().toISOString(),
  ) {
    if (!orders.length) return;
    const filled = orders.filter((order) => String(order.status) === "filled");
    const slippages = filled
      .map((order) => {
        const broker = order.payload?.broker ?? {};
        const referencePrice = Number(order.payload?.referencePrice);
        const filledAvgPrice = Number(
          broker.filledAvgPrice ?? order.payload?.filledAvgPrice,
        );
        const side = String(
          order.payload?.side ?? broker.side ?? "",
        ).toLowerCase();
        if (
          !Number.isFinite(referencePrice) ||
          referencePrice <= 0 ||
          !Number.isFinite(filledAvgPrice) ||
          !["buy", "sell"].includes(side)
        )
          return null;
        return side === "buy"
          ? ((filledAvgPrice - referencePrice) / referencePrice) * 10_000
          : ((referencePrice - filledAvgPrice) / referencePrice) * 10_000;
      })
      .filter((value): value is number => value !== null);
    const rows = [
      {
        runId,
        name: "strategy_paper_order_fill_ratio",
        value: filled.length / orders.length,
        unit: "ratio",
        asOf,
      },
      {
        runId,
        name: "strategy_paper_order_count",
        value: orders.length,
        unit: "count",
        asOf,
      },
    ];
    if (slippages.length)
      rows.push({
        runId,
        name: "strategy_slippage_estimate_bps",
        value:
          slippages.reduce((sum, value) => sum + value, 0) / slippages.length,
        unit: "bps",
        asOf,
      });
    recordMetricRows(rows);
  }

  function recordStrategyPerformanceMetrics(runId: string, performance: any) {
    const summary = performance?.summary ?? {};
    if (summary.status !== "available") return;
    const asOf =
      summary.lastMarkAt ?? performance.generatedAt ?? new Date().toISOString();
    const rows = [
      ["strategy_active_return_percent", summary.totalReturnPercent, "percent"],
      [
        "strategy_active_drawdown_percent",
        summary.maxDrawdownPercent,
        "percent",
      ],
      ["strategy_active_pnl_usd", summary.totalPnl, "usd"],
    ]
      .filter(([, value]) => Number.isFinite(Number(value)))
      .map(([name, value, unit]) => ({
        runId,
        name: String(name),
        value: Number(value),
        unit: String(unit),
        asOf,
      }));
    recordMetricRows(rows);
  }

  async function reconciledStrategyOrders(runId: string) {
    const orders = store.strategyOrders(runId);
    const reconcileStartedAt = Date.now();
    const traceId = crypto.randomUUID();
    await Promise.all(
      orders.slice(0, 50).map(async (order) => {
        try {
          const brokerOrder = await alpaca.trading.orders.getOrderByOrderID({
            orderId: order.paperOrderId,
            nested: true,
          });
          if (brokerOrder.id && brokerOrder.status)
            store.reconcileStrategyOrder(
              order.paperOrderId,
              brokerOrder.status,
              {
                broker: managedOrderDto(brokerOrder),
                brokerReconciledAt: new Date().toISOString(),
              },
            );
        } catch (error) {
          recordMetricRows([
            buildStrategyErrorMetric(runId, new Date().toISOString()),
          ]);
          store.event(
            "strategy.order.reconcile_failed",
            "strategy-attribution",
            {
              runId,
              paperOrderId: order.paperOrderId,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }),
    );
    const reconciled = store.strategyOrders(runId);
    recordStrategyOrderMetrics(runId, reconciled);
    recordSpan("strategy-reconciler", {
      traceId,
      name: "strategy.order.reconcile",
      startedAt: reconcileStartedAt,
      endedAt: Date.now(),
      attributes: {
        runId,
        orderCount: orders.length,
        reconciledCount: reconciled.length,
      },
    });
    return reconciled;
  }

  async function buildStrategyAttributionForRun(
    run: StrategyRunRecord,
    orders = store.strategyOrders(run.id),
  ) {
    const decisions = store.strategyDecisions(run.id, 500);
    const traces = decisions
      .map((decision) => store.getStrategyDecisionTrace(decision.traceId))
      .filter(Boolean) as any[];
    const fillTimes = orders
      .map((order) =>
        Date.parse(
          order.payload?.broker?.filledAt ?? order.payload?.filledAt ?? "",
        ),
      )
      .filter(Number.isFinite);
    const symbols = [
      ...new Set([
        ...run.symbols,
        ...orders
          .map((order) =>
            String(
              order.payload?.symbol ?? order.payload?.broker?.symbol ?? "",
            ),
          )
          .filter(Boolean),
      ]),
    ];
    let barsBySymbol: Record<string, any[]> = {};
    const warnings: string[] = [];
    if (fillTimes.length && symbols.length) {
      const start = new Date(Math.min(...fillTimes) - 60 * 60_000);
      const end = new Date();
      try {
        barsBySymbol = await alpaca.marketData.getCryptoBars({
          loc: "us",
          symbols,
          timeframe: "1Hour",
          start,
          end,
          limit: 10_000,
        } as any);
      } catch (error) {
        warnings.push(
          `Post-fill market bars unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const attribution = buildStrategyOrderAttribution({
      run,
      orders,
      barsBySymbol,
    });
    const executionReplay = buildStrategyExecutionReplay({
      run,
      orders: orders as any[],
      traces,
    });
    const replayByPaperOrderId = new Map(
      executionReplay.orders.map((order) => [order.paperOrderId, order]),
    );
    attribution.orders = attribution.orders.map((order) => ({
      ...order,
      executionReplay:
        replayByPaperOrderId.get(order.paperOrderId)?.replay ?? null,
    }));
    (attribution as any).executionReplay = executionReplay;
    attribution.warnings.push(...warnings);
    attribution.warnings.push(...executionReplay.warnings);
    return attribution;
  }

  async function buildStrategyPerformanceForRun(
    run: StrategyRunRecord,
    orders = store.strategyOrders(run.id),
  ) {
    const fillTimes = orders
      .map((order) =>
        Date.parse(
          order.payload?.broker?.filledAt ?? order.payload?.filledAt ?? "",
        ),
      )
      .filter(Number.isFinite);
    const symbols = [
      ...new Set([
        ...run.symbols,
        ...orders
          .map((order) =>
            String(
              order.payload?.symbol ?? order.payload?.broker?.symbol ?? "",
            ),
          )
          .filter(Boolean),
      ]),
    ];
    let barsBySymbol: Record<string, any[]> = {};
    const warnings: string[] = [];
    if (fillTimes.length && symbols.length) {
      const start = new Date(Math.min(...fillTimes) - 60 * 60_000);
      const end = new Date();
      try {
        barsBySymbol = await alpaca.marketData.getCryptoBars({
          loc: "us",
          symbols,
          timeframe: "1Hour",
          start,
          end,
          limit: 10_000,
        } as any);
      } catch (error) {
        warnings.push(
          `Active-run performance bars unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const performance = buildStrategyPerformance({ run, orders, barsBySymbol });
    performance.warnings.push(...warnings);
    recordStrategyPerformanceMetrics(run.id, performance);
    return performance;
  }

  async function buildStrategyAlertsForRun(run: StrategyRunRecord) {
    const orders = await reconciledStrategyOrders(run.id);
    const decisions = store.strategyDecisions(run.id, 500);
    const traces = decisions
      .map((decision) => store.getStrategyDecisionTrace(decision.traceId))
      .filter(Boolean);
    let performance: unknown = null;
    try {
      performance = await buildStrategyPerformanceForRun(run, orders);
    } catch (error) {
      recordMetricRows([
        buildStrategyErrorMetric(run.id, new Date().toISOString()),
      ]);
      store.event(
        "strategy.alerts.performance_unavailable",
        "strategy-alerts",
        {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    const result = buildStrategyAlerts({
      run,
      decisions: decisions as any[],
      traces: traces as any[],
      orders,
      metrics: store.strategyMetrics(run.id) as any[],
      performance,
    });
    if (result.alerts.length)
      store.event("strategy.alerts.generated", "strategy-alerts", {
        runId: run.id,
        alerts: result.alerts.map((alert) => ({
          code: alert.code,
          severity: alert.severity,
        })),
      });
    return result;
  }

  return {
    recordOrderMetrics: recordStrategyOrderMetrics,
    reconcileOrders: reconciledStrategyOrders,
    buildAttribution: buildStrategyAttributionForRun,
    buildPerformance: buildStrategyPerformanceForRun,
    buildAlerts: buildStrategyAlertsForRun,
  };
}
