import { createHash, randomUUID } from "node:crypto";
import { TimeFrame, type Alpaca } from "@alpacahq/alpaca-ts-alpha";
import type { createStore } from "../../persistence/store";
import { workingBrokerOrderStatuses } from "../../shared/broker-status";
import type { createOrderRuntime } from "../orders/runtime";

type Store = ReturnType<typeof createStore>;
type OrderRuntime = ReturnType<typeof createOrderRuntime>;
type Trigger = "manual" | "scheduler";
type Domain = "market_bar" | "account" | "order";
type Severity = "warning" | "error";
type RecoveryStatus =
  | "not_applicable"
  | "local_state_synchronized"
  | "unresolved";

export type ReconciliationDiscrepancy = {
  id: string;
  domain: Domain;
  code: string;
  severity: Severity;
  subject: string;
  detail: Record<string, unknown>;
  recovery: {
    status: RecoveryStatus;
    action: string;
    verifiedAt: string;
  };
};

export type ReconciliationRun = {
  schemaVersion: "scheduled-reconciliation-v1";
  runId: string;
  trigger: Trigger;
  actor: string;
  startedAt: string;
  completedAt: string;
  status: "healthy" | "warning" | "error";
  scope: {
    marketSymbols: string[];
    omittedMarketSymbols: number;
    listedOrders: number;
    detailedOrders: number;
    omittedDetailedOrders: number;
  };
  checks: {
    marketBars: "passed" | "skipped" | "failed";
    account: "passed" | "failed";
    orders: "passed" | "skipped" | "failed";
  };
  discrepancies: ReconciliationDiscrepancy[];
  summary: {
    discrepancyCount: number;
    recoveredCount: number;
    unresolvedCount: number;
    warningCount: number;
    errorCount: number;
  };
};

type ComparableBar = {
  observedAt: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number | null;
  vwap: number | null;
};

const MAX_MARKET_SYMBOLS = 20;
const MAX_ORDER_DETAILS = 25;

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function iso(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function comparableBar(value: any): ComparableBar | null {
  const observedAt = iso(value?.timestamp ?? value?.t);
  const open = finite(value?.open ?? value?.o);
  const high = finite(value?.high ?? value?.h);
  const low = finite(value?.low ?? value?.l);
  const close = finite(value?.close ?? value?.c);
  const volume = finite(value?.volume ?? value?.v);
  if (
    !observedAt ||
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    volume === null
  )
    return null;
  return {
    observedAt,
    open,
    high,
    low,
    close,
    volume,
    tradeCount: finite(value?.tradeCount ?? value?.n),
    vwap: finite(value?.vwap ?? value?.vw),
  };
}

function fingerprint(value: ComparableBar) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function mismatchedBarFields(left: ComparableBar, right: ComparableBar) {
  return (
    ["open", "high", "low", "close", "volume", "tradeCount", "vwap"] as const
  ).filter((field) => left[field] !== right[field]);
}

function orderObservation(order: any) {
  return {
    status: String(order?.status ?? ""),
    filledQty: finite(order?.filledQty),
    filledAvgPrice:
      order?.filledAvgPrice === null || order?.filledAvgPrice === undefined
        ? null
        : finite(order.filledAvgPrice),
    updatedAt: iso(order?.updatedAt),
  };
}

function orderDifferences(left: any, right: any) {
  const a = orderObservation(left),
    b = orderObservation(right);
  return (Object.keys(a) as (keyof typeof a)[]).filter(
    (field) => a[field] !== b[field],
  );
}

function sourceSummary(order: any, endpoint: string) {
  const observation = orderObservation(order);
  return {
    endpoint,
    ...observation,
    fingerprint: `sha256:${createHash("sha256")
      .update(JSON.stringify(observation))
      .digest("hex")}`,
  };
}

function errorDiscrepancy(
  domain: Domain,
  code: string,
  subject: string,
  verifiedAt: string,
): ReconciliationDiscrepancy {
  return {
    id: randomUUID(),
    domain,
    code,
    severity: "error",
    subject,
    detail: {},
    recovery: {
      status: "unresolved",
      action: "No local recovery was safe because an independent query failed.",
      verifiedAt,
    },
  };
}

function runSummary(discrepancies: ReconciliationDiscrepancy[]) {
  return {
    discrepancyCount: discrepancies.length,
    recoveredCount: discrepancies.filter(
      (item) => item.recovery.status === "local_state_synchronized",
    ).length,
    unresolvedCount: discrepancies.filter(
      (item) => item.recovery.status === "unresolved",
    ).length,
    warningCount: discrepancies.filter((item) => item.severity === "warning")
      .length,
    errorCount: discrepancies.filter((item) => item.severity === "error")
      .length,
  };
}

/**
 * Reconciles bounded paper-account evidence through distinct Alpaca query
 * paths. It never submits, replaces, or cancels a broker order.
 */
export function createReconciliationService({
  alpaca,
  store,
  orderRuntime,
  now = () => new Date(),
}: {
  alpaca: Alpaca;
  store: Store;
  orderRuntime: OrderRuntime;
  now?: () => Date;
}) {
  let activeRun: Promise<ReconciliationRun> | null = null;

  async function execute(trigger: Trigger, actor: string) {
    const startedAt = now().toISOString();
    const runId = randomUUID();
    const discrepancies: ReconciliationDiscrepancy[] = [];
    const checks: ReconciliationRun["checks"] = {
      marketBars: "skipped",
      account: "passed",
      orders: "skipped",
    };
    let marketSymbols: string[] = [];
    let omittedMarketSymbols = 0;
    let listedOrders: any[] = [];
    let detailCandidates: any[] = [];
    let totalDetailCandidates = 0;

    const brokerState = await Promise.allSettled([
      alpaca.trading.account.getAccount(),
      alpaca.trading.positions.getAllOpenPositions(),
      alpaca.trading.orders.getAllOrders({
        status: "open",
        limit: 100,
        direction: "desc",
        nested: true,
      }),
    ]);
    const [accountResult, positionsResult, ordersResult] = brokerState;
    const account =
      accountResult.status === "fulfilled" ? accountResult.value : null;
    const positions =
      positionsResult.status === "fulfilled" ? positionsResult.value : [];
    listedOrders = ordersResult.status === "fulfilled" ? ordersResult.value : [];
    const stateRetrievedAt = now().toISOString();

    if (!account || positionsResult.status === "rejected") {
      checks.account = "failed";
      if (!account)
        discrepancies.push(
          errorDiscrepancy(
            "account",
            "account_query_failed",
            "paper-account",
            stateRetrievedAt,
          ),
        );
      if (positionsResult.status === "rejected")
        discrepancies.push(
          errorDiscrepancy(
            "account",
            "positions_query_failed",
            "paper-positions",
            stateRetrievedAt,
          ),
        );
    } else {
      const equity = finite(account.equity),
        cash = finite(account.cash);
      const invalidPositionSymbols = positions
        .filter((position) => finite(position.marketValue) === null)
        .map((position) => String(position.symbol ?? "unknown"));
      const positionValue = positions.reduce(
        (sum, position) => sum + Number(position.marketValue),
        0,
      );
      if (equity === null || cash === null || invalidPositionSymbols.length) {
        checks.account = "failed";
        const discrepancy = errorDiscrepancy(
          "account",
          invalidPositionSymbols.length
            ? "position_values_unavailable"
            : "account_values_unavailable",
          "paper-account",
          stateRetrievedAt,
        );
        discrepancy.detail = invalidPositionSymbols.length
          ? { invalidPositionSymbols }
          : {};
        discrepancies.push(discrepancy);
      } else {
        const gap = equity - cash - positionValue;
        const tolerance = Math.max(1, Math.abs(equity) * 0.001);
        if (Math.abs(gap) > tolerance) {
          discrepancies.push({
            id: randomUUID(),
            domain: "account",
            code: "equity_position_reconciliation_gap",
            severity: "warning",
            subject: "paper-account",
            detail: {
              gap,
              tolerance,
              positionCount: positions.length,
              accountEndpoint: "trading.account.getAccount",
              positionsEndpoint: "trading.positions.getAllOpenPositions",
            },
            recovery: {
              status: "not_applicable",
              action:
                "Recorded for operator review; reconciliation is read-only and does not alter broker account values.",
              verifiedAt: stateRetrievedAt,
            },
          });
        }
      }
      if (String(account.status ?? "").toUpperCase() !== "ACTIVE") {
        checks.account = "failed";
        discrepancies.push({
          id: randomUUID(),
          domain: "account",
          code: "account_not_active",
          severity: "error",
          subject: "paper-account",
          detail: { status: String(account.status ?? "unknown") },
          recovery: {
            status: "unresolved",
            action:
              "Broker account status cannot be recovered locally; paper execution remains fail-closed.",
            verifiedAt: stateRetrievedAt,
          },
        });
      }
    }

    if (ordersResult.status === "rejected") {
      checks.orders = "failed";
      discrepancies.push(
        errorDiscrepancy(
          "order",
          "bulk_order_query_failed",
          "paper-orders",
          stateRetrievedAt,
        ),
      );
    } else {
      const listedById = new Map(
        listedOrders
          .filter((order) => order.id)
          .map((order) => [String(order.id), order] as const),
      );
      for (const order of listedOrders)
        orderRuntime.applyBrokerSnapshot(order, now());
      const candidateIds = [
        ...new Set(
          [
            ...listedOrders
              .filter((order) =>
                workingBrokerOrderStatuses.has(String(order.status)),
              )
              .map((order) => String(order.id ?? "")),
            ...orderRuntime.tracker
              .list("open", 100)
              .map((order) => String(order.id ?? "")),
          ].filter(Boolean),
        ),
      ];
      totalDetailCandidates = candidateIds.length;
      detailCandidates = candidateIds
        .slice(0, MAX_ORDER_DETAILS)
        .map((id) => listedById.get(id) ?? { id });
      checks.orders = detailCandidates.length ? "passed" : "skipped";
      const detailResults = await Promise.allSettled(
        detailCandidates.map((order) =>
          alpaca.trading.orders.getOrderByOrderID({ orderId: String(order.id) }),
        ),
      );
      for (let index = 0; index < detailCandidates.length; index++) {
        const candidate = detailCandidates[index]!;
        const orderId = String(candidate.id);
        const detailResult = detailResults[index]!;
        const bulk = listedById.get(orderId);
        const verifiedAt = now().toISOString();
        if (detailResult.status === "rejected") {
          checks.orders = "failed";
          discrepancies.push(
            errorDiscrepancy(
              "order",
              "order_detail_query_failed",
              orderId,
              verifiedAt,
            ),
          );
          continue;
        }
        const detail = detailResult.value;
        const differences = bulk ? orderDifferences(bulk, detail) : ["missing"];
        const bulkObservedMs = bulk
          ? Date.parse(orderObservation(bulk).updatedAt ?? "")
          : Number.NEGATIVE_INFINITY;
        const detailObservedMs = Date.parse(
          orderObservation(detail).updatedAt ?? "",
        );
        const unambiguousDetail =
          !bulk ||
          (Number.isFinite(detailObservedMs) &&
            (!Number.isFinite(bulkObservedMs) ||
              detailObservedMs > bulkObservedMs));
        if (unambiguousDetail) orderRuntime.applyBrokerSnapshot(detail, now());
        if (!differences.length) continue;
        checks.orders = "failed";
        const selected = unambiguousDetail ? detail : bulk;
        const ambiguous =
          Boolean(bulk) &&
          (!Number.isFinite(bulkObservedMs) ||
            !Number.isFinite(detailObservedMs) ||
            bulkObservedMs === detailObservedMs);
        const tracked = orderRuntime.tracker
          .list("all", 100)
          .find((order) => order.id === orderId);
        const synchronized =
          !ambiguous &&
          Boolean(tracked) &&
          Boolean(selected) &&
          orderDifferences(tracked, selected).length === 0;
        discrepancies.push({
          id: randomUUID(),
          domain: "order",
          code: bulk ? "order_query_mismatch" : "bulk_order_missing",
          severity: "error",
          subject: orderId,
          detail: {
            mismatchedFields: differences,
            bulk: bulk
              ? sourceSummary(bulk, "trading.orders.getAllOrders")
              : null,
            detail: sourceSummary(
              detail,
              "trading.orders.getOrderByOrderID",
            ),
            selectedEndpoint: unambiguousDetail
              ? "trading.orders.getOrderByOrderID"
              : "trading.orders.getAllOrders",
            ambiguousObservationTime: ambiguous,
          },
          recovery: {
            status: synchronized
              ? "local_state_synchronized"
              : "unresolved",
            action: synchronized
              ? `Updated the local order projection and persisted receipt state from the newer ${unambiguousDetail ? "per-order" : "bulk-list"} broker observation.`
              : "The broker queries disagreed without an unambiguous newer observation; local recovery remains unresolved.",
            verifiedAt,
          },
        });
      }
    }

    const allSymbols = [
      ...new Set(
        [
          ...positions.map((position) => String(position.symbol ?? "")),
          ...listedOrders
            .filter((order) =>
              workingBrokerOrderStatuses.has(String(order.status)),
            )
            .map((order) => String(order.symbol ?? "")),
        ]
          .map((symbol) => symbol.trim().toUpperCase())
          .filter((symbol) => /^[A-Z.]{1,10}$/.test(symbol)),
      ),
    ].sort();
    marketSymbols = allSymbols.slice(0, MAX_MARKET_SYMBOLS);
    omittedMarketSymbols = allSymbols.length - marketSymbols.length;
    if (marketSymbols.length) {
      checks.marketBars = "passed";
      const latestResult = await Promise.allSettled([
        alpaca.marketData.stocks.stockLatestBars({
          symbols: marketSymbols.join(","),
          feed: "iex",
        }),
        Promise.allSettled(
          marketSymbols.map((symbol) =>
            alpaca.marketData.getStockBarsFor(symbol, {
              timeframe: TimeFrame.Minute,
              start: new Date(now().getTime() - 10 * 86_400_000),
              end: now(),
              feed: "iex",
            }),
          ),
        ),
      ]);
      const marketVerifiedAt = now().toISOString();
      if (latestResult.some((result) => result.status === "rejected")) {
        checks.marketBars = "failed";
        discrepancies.push(
          errorDiscrepancy(
            "market_bar",
            latestResult[0]!.status === "rejected"
              ? "latest_bar_query_failed"
              : "historical_bar_query_failed",
            "portfolio-and-open-order-symbols",
            marketVerifiedAt,
          ),
        );
      } else {
        const latestResponse = latestResult[0];
        const historyResponse = latestResult[1];
        if (
          latestResponse.status !== "fulfilled" ||
          historyResponse.status !== "fulfilled"
        )
          throw new Error("Market reconciliation result narrowing failed");
        const latestBars = latestResponse.value.bars ?? {};
        const histories = historyResponse.value;
        for (let index = 0; index < marketSymbols.length; index++) {
          const symbol = marketSymbols[index]!;
          const latest = comparableBar(latestBars[symbol]);
          const historyResult = histories[index];
          if (!historyResult || historyResult.status === "rejected") {
            checks.marketBars = "failed";
            discrepancies.push(
              errorDiscrepancy(
                "market_bar",
                "historical_bar_query_failed",
                symbol,
                marketVerifiedAt,
              ),
            );
            continue;
          }
          const history = historyResult.value;
          const historical = comparableBar(history.at(-1));
          if (!latest || !historical) {
            checks.marketBars = "failed";
            discrepancies.push(
              errorDiscrepancy(
                "market_bar",
                !latest ? "latest_bar_unavailable" : "historical_bar_unavailable",
                symbol,
                marketVerifiedAt,
              ),
            );
            continue;
          }
          const fields = mismatchedBarFields(latest, historical);
          if (latest.observedAt === historical.observedAt && !fields.length)
            continue;
          discrepancies.push({
            id: randomUUID(),
            domain: "market_bar",
            code:
              latest.observedAt === historical.observedAt
                ? "bar_revision_mismatch"
                : Date.parse(latest.observedAt) > Date.parse(historical.observedAt)
                  ? "historical_bar_lag"
                  : "latest_bar_lag",
            severity: "warning",
            subject: symbol,
            detail: {
              mismatchedFields: fields,
              latest: {
                endpoint: "marketData.stocks.stockLatestBars",
                observedAt: latest.observedAt,
                fingerprint: fingerprint(latest),
              },
              historical: {
                endpoint: "marketData.getStockBarsFor",
                observedAt: historical.observedAt,
                fingerprint: fingerprint(historical),
              },
              feed: "iex",
            },
            recovery: {
              status: "not_applicable",
              action:
                "Recorded both immutable fingerprints; reconciliation does not rewrite provider market data.",
              verifiedAt: marketVerifiedAt,
            },
          });
        }
      }
    }

    const completedAt = now().toISOString();
    const summary = runSummary(discrepancies);
    const status = summary.errorCount
      ? "error"
      : summary.warningCount
        ? "warning"
        : "healthy";
    const run: ReconciliationRun = {
      schemaVersion: "scheduled-reconciliation-v1",
      runId,
      trigger,
      actor,
      startedAt,
      completedAt,
      status,
      scope: {
        marketSymbols,
        omittedMarketSymbols,
        listedOrders: listedOrders.length,
        detailedOrders: detailCandidates.length,
        omittedDetailedOrders: Math.max(
          0,
          totalDetailCandidates - MAX_ORDER_DETAILS,
        ),
      },
      checks,
      discrepancies,
      summary,
    };
    for (const discrepancy of discrepancies) {
      store.event("operations.reconciliation.discrepancy", actor, {
        runId,
        ...discrepancy,
      });
      store.event("operations.reconciliation.recovery", actor, {
        runId,
        discrepancyId: discrepancy.id,
        domain: discrepancy.domain,
        subject: discrepancy.subject,
        ...discrepancy.recovery,
      });
    }
    store.event("operations.reconciliation.completed", actor, run);
    return run;
  }

  function run(trigger: Trigger, actor: string) {
    activeRun ??= execute(trigger, actor)
      .catch((error) => {
        store.event("operations.reconciliation.failed", actor, {
          schemaVersion: "scheduled-reconciliation-failure-v1",
          trigger,
          failedAt: new Date().toISOString(),
          reason: "unexpected_reconciliation_failure",
          errorType:
            error instanceof Error ? error.constructor.name : "UnknownError",
        });
        throw error;
      })
      .finally(() => {
        activeRun = null;
      });
    return activeRun;
  }

  return { run };
}

export function reconciliationReport(store: Store) {
  const runs = store
    .events(1_000, "operations.reconciliation.completed")
    .map((event) => event.payload as ReconciliationRun);
  const failures = store.events(1_000, "operations.reconciliation.failed");
  return {
    reportVersion: "reconciliation-report-v1",
    generatedAt: new Date().toISOString(),
    latest: runs[0] ?? null,
    recentRuns: runs.slice(0, 20),
    evidence: {
      completedRuns: runs.length,
      discrepancyEvents: store.events(
        1_000,
        "operations.reconciliation.discrepancy",
      ).length,
      recoveryEvents: store.events(
        1_000,
        "operations.reconciliation.recovery",
      ).length,
      failedRuns: failures.length,
      latestFailure: failures[0]?.payload ?? null,
    },
    boundaries: [
      "Market bars compare two Alpaca IEX REST paths; this is endpoint independence, not an independent market-data provider.",
      "Account reconciliation compares the account endpoint with separately queried positions and does not mutate broker values.",
      "Order reconciliation compares the bounded bulk listing with per-order detail and may synchronize only the local projection and receipts.",
      "No reconciliation action submits, replaces, cancels, or otherwise authorizes a broker order.",
    ],
  };
}
