import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { conflict } from "../../http/http";
import type { createStore } from "../../persistence/store";
import {
  evaluateOperationsPolicy,
  type OperationsPolicyEvaluation,
} from "../../shared/operations-policy";
import { cryptoOrderMarketFromSnapshot } from "../orders/crypto-order-ticket";
import { managedOrderDto } from "../orders/order-management";
import { rollingTurnover } from "../../shared/risk";
import {
  evaluateStrategyPlugin,
  strategyPluginFromId,
} from "./strategy-backtest";
import { strategySupportsPaperAutomation } from "./strategy-paper-readiness";
import {
  cryptoBarsDto,
  cryptoSnapshotDto,
} from "./crypto-strategy-data";
import {
  draftStrategyPaperOrder,
  evaluateStrategyPaperRiskPolicy,
  strategyPaperState,
  type StrategyPaperApproval,
} from "./strategy-paper";
import { buildStrategyPerformance } from "./strategy-performance";
import {
  canonicalHash,
  type CodeIdentity,
  type StrategyProvenance,
} from "./strategy-provenance";
import {
  normalizeStrategySchedule,
  strategyRunIsDue,
  withNextStrategySchedule,
} from "./strategy-scheduler";
import {
  buildStrategyDecisionMetrics,
  buildStrategyErrorMetric,
  buildStrategySpan,
} from "./strategy-observability";
import {
  normalizeStrategySymbols,
  strategyAuditSnapshot,
  strategyConfigHash,
  strategyDefinition,
  strategyProvenance,
  withoutAsOf,
} from "./strategy-runtime-provenance";
import { createStrategyReporting } from "./strategy-runtime-reporting";

type Store = ReturnType<typeof createStore>;

/** Owns strategy evaluation, paper-risk decisions, evidence, and scheduler state. */
export function createStrategyRuntime(
  alpaca: Alpaca,
  store: Store,
  codeIdentity: CodeIdentity = {
    gitCommit: "0".repeat(40),
    workingTreeDirty: true,
  },
) {
  type StrategyRunRecord = NonNullable<ReturnType<typeof store.getStrategyRun>>;
  type StrategyTickTrigger = "manual" | "scheduler";

  function recordStrategyAudit(
    actor: string,
    kind: string,
    subject: string,
    beforeRun: StrategyRunRecord | null | undefined,
    afterRun: StrategyRunRecord | null | undefined,
    metadata: Record<string, unknown> = {},
  ) {
    const run = afterRun ?? beforeRun;
    if (!run) return;
    try {
      store.strategyAudit({
        runId: run.id,
        kind,
        actor,
        subject,
        strategyId: run.strategyId,
        strategyVersion: run.strategyVersion,
        policyVersion: run.policyVersion,
        configHash: run.configHash,
        before: strategyAuditSnapshot(beforeRun),
        after: strategyAuditSnapshot(afterRun),
        metadata,
      });
    } catch (error) {
      store.event("strategy.audit.persist_failed", "strategy-audit", {
        runId: run.id,
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function recordStrategyBlock(
    run: StrategyRunRecord,
    actor: string,
    symbol: string,
    reasonCode: string,
    reason: string,
    trigger: StrategyTickTrigger,
    provenance: StrategyProvenance,
    dataSnapshotIds: string[],
    mode = run.status,
    tickStartedAt = Date.now(),
    traceId = crypto.randomUUID(),
  ) {
    const decisionId = crypto.randomUUID(),
      receiptId = crypto.randomUUID();
    const config = run.config as { params?: Record<string, unknown> };
    store.strategyDecision({
      id: decisionId,
      traceId,
      runId: run.id,
      symbol,
      decision: "block",
      features: {},
      weights: {},
      thresholds: config.params ?? {},
      riskChecks: {
        allowed: false,
        mode,
        trigger,
        submittedOrder: false,
        reasons: [reasonCode],
        intendedAction: "missed",
      },
      dataSnapshotIds,
      rawSignal: null,
      riskAdjustedSignal: null,
      targetPosition: null,
      reason,
      provenance,
    });
    const trace = store.getStrategyDecisionTrace(traceId);
    const asOf = new Date().toISOString();
    recordStrategyMetricRows(
      buildStrategyDecisionMetrics({
        runId: run.id,
        asOf,
        tickLatencyMs: Date.now() - tickStartedAt,
        snapshots: [],
        decision: "block",
        submittedOrder: false,
      }),
    );
    recordStrategySpan(actor, {
      traceId,
      name: "strategy.decision",
      startedAt: tickStartedAt,
      endedAt: Date.now(),
      attributes: {
        runId: run.id,
        symbol,
        decision: "block",
        trigger,
        reasonCode,
      },
    });
    store.receipt(receiptId, {
      advisor: actor,
      kind:
        mode === "paper"
          ? "strategy_paper_decision"
          : "strategy_shadow_decision",
      runId: run.id,
      traceId,
      decisionId,
      symbol,
      decision: "block",
      submittedOrder: false,
      trigger,
      createdAt: asOf,
    });
    store.event(`strategy.${mode}.blocked`, actor, {
      runId: run.id,
      traceId,
      decisionId,
      symbol,
      trigger,
      reason: reasonCode,
    });
    return { runId: run.id, traceId, decisionId, receiptId, trace };
  }

  function cryptoSnapshotQuote(record: { payload: any } | undefined) {
    const bid = Number(record?.payload?.quote?.bid),
      ask = Number(record?.payload?.quote?.ask);
    const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
    const spreadBps =
      midpoint && ask >= bid ? ((ask - bid) / midpoint) * 10_000 : null;
    return {
      bid: bid > 0 ? bid : null,
      ask: ask > 0 ? ask : null,
      midpoint,
      spreadBps,
    };
  }

  function normalizeCryptoPositionSymbol(symbol: string) {
    return symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  }

  function cryptoPositionQty(positions: any[], symbol: string) {
    const target = normalizeCryptoPositionSymbol(symbol);
    const position = positions.find(
      (item) =>
        normalizeCryptoPositionSymbol(String(item.symbol ?? "")) === target,
    );
    const qty = Number(position?.qty ?? position?.quantity ?? 0);
    return Number.isFinite(qty) && qty > 0 ? qty : 0;
  }

  async function latestCryptoOrderMarket(symbol: string) {
    const [snapshots, orderbooks] = await Promise.all([
      alpaca.marketData.crypto
        .cryptoSnapshots({ loc: "us", symbols: symbol })
        .then((result) => result.snapshots ?? {}),
      alpaca.marketData.crypto
        .cryptoLatestOrderbooks({ loc: "us", symbols: symbol })
        .then((result) => result.orderbooks ?? {})
        .catch(() => ({})),
    ]);
    const result = cryptoSnapshotDto({
      symbols: [symbol],
      snapshots,
      orderbooks,
      receivedAt: new Date(),
    });
    const record = result.records[0];
    if (!record) throw new Error("Crypto market snapshot unavailable");
    return { record, market: cryptoOrderMarketFromSnapshot(record.payload) };
  }

  function recordStrategyMetricRows(
    rows: {
      runId: string;
      name: string;
      value: number;
      unit: string;
      asOf: string;
    }[],
  ) {
    for (const row of rows) {
      try {
        store.strategyMetric(row);
      } catch (error) {
        store.event(
          "strategy.metric.persist_failed",
          "strategy-observability",
          {
            runId: row.runId,
            name: row.name,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }

  function recordStrategySpan(
    actor: string,
    input: Parameters<typeof buildStrategySpan>[0],
  ) {
    try {
      store.event("otel.span", actor, buildStrategySpan(input));
    } catch (error) {
      console.error(
        "strategy span persist failed",
        error instanceof Error ? error.message : error,
      );
    }
  }

  const reporting = createStrategyReporting({
    alpaca,
    store,
    recordMetricRows: recordStrategyMetricRows,
    recordSpan: recordStrategySpan,
  });

  function paperOrderSlippageBps(
    order: any,
    referencePrice: number | null | undefined,
  ) {
    const filledAvgPrice = Number(
      order?.filledAvgPrice ?? order?.filled_avg_price,
    );
    const side = String(order?.side ?? "").toLowerCase();
    if (
      !referencePrice ||
      !Number.isFinite(referencePrice) ||
      !Number.isFinite(filledAvgPrice) ||
      !["buy", "sell"].includes(side)
    )
      return null;
    return side === "buy"
      ? ((filledAvgPrice - referencePrice) / referencePrice) * 10_000
      : ((referencePrice - filledAvgPrice) / referencePrice) * 10_000;
  }

  async function evaluateStrategyRun(
    run: StrategyRunRecord,
    actor: string,
    trigger: StrategyTickTrigger,
  ) {
    const tickStartedAt = Date.now(),
      traceId = crypto.randomUUID();
    if (!["shadow", "paper"].includes(run.status))
      throw conflict(
        "Only shadow or approved paper runs can be evaluated by this endpoint",
        "strategy_run_state_conflict",
        true,
        "refresh_strategy_run",
      );
    if (!run.backtestId || !run.provenance || !run.comparable)
      throw conflict(
        "Legacy strategy runs cannot be evaluated without a reviewed backtest; create a new run",
        "strategy_backtest_required",
        true,
        "create_matching_backtest",
      );
    const config = run.config as {
      symbols: string[];
      strategyId: string;
      params?: Record<string, unknown>;
      timeframe: string;
      days: number;
    };
    const symbols = config.symbols;
    const symbol = symbols[0]!;
    const strategy = strategyPluginFromId(
      config.strategyId,
      config.params ?? {},
    );
    const end = new Date(),
      start = new Date(end.getTime() - config.days * 86_400_000);
    const requestedSymbols = symbols.join(",");
    const dataStartedAt = Date.now();
    const [barsBySymbol, snapshotResponse, orderbookResponse] =
      await Promise.all([
        alpaca.marketData.getCryptoBars({
          loc: "us",
          symbols,
          timeframe: config.timeframe,
          start,
          end,
          limit: 10_000,
        } as any),
        alpaca.marketData.crypto
          .cryptoSnapshots({ loc: "us", symbols: requestedSymbols })
          .then((result) => result.snapshots ?? {}),
        alpaca.marketData.crypto
          .cryptoLatestOrderbooks({ loc: "us", symbols: requestedSymbols })
          .then((result) => result.orderbooks ?? {})
          // Order-book depth is optional enrichment; its failure does not abort
          // evaluation with the bars and snapshot data that are still present.
          .catch(() => ({})),
      ]);
    recordStrategySpan(actor, {
      traceId,
      name: "strategy.market_data.fetch",
      startedAt: dataStartedAt,
      endedAt: Date.now(),
      attributes: {
        runId: run.id,
        symbol,
        symbols,
        timeframe: config.timeframe,
        days: config.days,
      },
    });
    const ingestStartedAt = Date.now();
    const barDataset = cryptoBarsDto({
      symbols,
      timeframe: config.timeframe,
      start,
      end,
      bars: barsBySymbol,
    });
    const normalizedBarsBySymbol = barDataset.bars;
    const bars = normalizedBarsBySymbol[symbol] ?? [];
    const snapshotResult = cryptoSnapshotDto({
      symbols,
      snapshots: snapshotResponse,
      orderbooks: orderbookResponse,
      receivedAt: new Date(),
    });
    const snapshotEvidence = {
      source: snapshotResult.source,
      feed: snapshotResult.feed,
      records: snapshotResult.records.map(({ id: _, ...record }) => record),
    };
    for (const record of snapshotResult.records) {
      const { id: _, ...content } = record;
      store.strategyDataSnapshot({
        ...record,
        runId: run.id,
        datasetHash: canonicalHash(content),
      });
    }
    const provenance = strategyProvenance(codeIdentity, {
      pluginVersion: strategy.version,
      policyVersion: run.policyVersion,
      definitionHash: run.provenance.definitionHash,
      start,
      end,
      timeframe: config.timeframe,
      symbols,
      datasetHash: canonicalHash({
        bars: withoutAsOf(barDataset),
        snapshots: snapshotEvidence,
      }),
    });
    recordStrategySpan(actor, {
      traceId,
      name: "strategy.market_data.ingest",
      startedAt: ingestStartedAt,
      endedAt: Date.now(),
      attributes: {
        runId: run.id,
        symbol,
        snapshotCount: snapshotResult.records.length,
        staleSnapshotCount: snapshotResult.records.filter(
          (record) => record.stale,
        ).length,
      },
    });
    if (!bars.length) {
      recordStrategySpan(actor, {
        traceId,
        name: "strategy.tick",
        startedAt: tickStartedAt,
        endedAt: Date.now(),
        status: "error",
        error: "data_unavailable",
        attributes: { runId: run.id, symbol, mode: run.status, trigger },
      });
      return recordStrategyBlock(
        run,
        actor,
        symbol,
        "data_unavailable",
        "Strategy tick missed because no crypto bars were available.",
        trigger,
        provenance,
        snapshotResult.records.map((record) => record.id),
        run.status,
        tickStartedAt,
        traceId,
      );
    }
    const featureStartedAt = Date.now();
    const decisionOutput = evaluateStrategyPlugin(
      strategy,
      bars,
      bars.length - 1,
      symbol,
      {
        histories: normalizedBarsBySymbol,
        snapshots: Object.fromEntries(
          snapshotResult.records.map((record) => [record.symbol, record]),
        ),
      },
    );
    recordStrategySpan(actor, {
      traceId,
      name: "strategy.feature_calculation",
      startedAt: featureStartedAt,
      endedAt: Date.now(),
      attributes: {
        runId: run.id,
        symbol,
        strategyId: strategy.id,
        strategyVersion: strategy.version,
        bars: bars.length,
      },
    });
    const riskStartedAt = Date.now();
    const hasStaleData = snapshotResult.records.some((record) => record.stale);
    const quote = cryptoSnapshotQuote(snapshotResult.records[0]);
    const referencePrice = quote.midpoint ?? Number(bars.at(-1)?.close);
    const paperApproval = (
      run.config as { paperApproval?: StrategyPaperApproval }
    ).paperApproval;
    const paperAutomationSupported = strategySupportsPaperAutomation(
      config.strategyId,
    );
    const paperOrders =
      run.status === "paper" ? store.strategyOrders(run.id) : [];
    const paperState =
      run.status === "paper"
        ? strategyPaperState(paperOrders)
        : { netNotional: 0 };
    const paperDraft =
      run.status === "paper" && paperAutomationSupported && !hasStaleData && paperApproval
        ? draftStrategyPaperOrder({
            approval: paperApproval,
            symbol,
            targetExposure: decisionOutput.targetExposure,
            currentNotional: paperState.netNotional,
            referencePrice,
            spreadBps: quote.spreadBps,
          })
        : null;
    let paperRiskPolicy: ReturnType<
        typeof evaluateStrategyPaperRiskPolicy
      > | null = null,
      paperOperationsPolicy: OperationsPolicyEvaluation | null = null,
      paperAccountError: string | null = null;
    if (
      run.status === "paper" &&
      paperAutomationSupported &&
      paperApproval &&
      paperDraft?.allowed &&
      paperDraft.order
    ) {
      let account: any = null,
        positions: any[] = [],
        recentOrders: any[] = [];
      try {
        [account, positions, recentOrders] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
          alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
        ]);
      } catch (error) {
        paperAccountError =
          error instanceof Error ? error.message : String(error);
      }
      if (!paperAccountError && recentOrders.length >= 500)
        paperAccountError = "The complete order window could not be verified";
      const performance = buildStrategyPerformance({
        run,
        orders: paperOrders as any[],
        barsBySymbol: { [symbol]: bars },
        generatedAt: new Date().toISOString(),
      });
      paperRiskPolicy = evaluateStrategyPaperRiskPolicy({
        approval: paperApproval,
        draftOrder: paperDraft.order,
        account,
        orders: paperOrders as any[],
        decisions: store.strategyDecisions(run.id, 50) as any[],
        performance,
      });
      if (paperAccountError)
        (paperRiskPolicy.evidence as Record<string, unknown>).accountError =
          paperAccountError;
      if (account && !paperAccountError) {
        paperOperationsPolicy = evaluateOperationsPolicy({
          policy: store.operationsPolicy(),
          order: {
            assetClass: "strategy_crypto",
            symbol,
            side: paperDraft.order.side,
            notional: paperDraft.order.notional,
            qty: paperDraft.order.qty,
            price: referencePrice,
          },
          account,
          positions,
          dailyTurnover: rollingTurnover(recentOrders),
        });
      }
    }
    const intendedAction =
      run.status === "paper" && paperDraft?.order
        ? paperDraft.order.side === "buy"
          ? paperState.netNotional > 0
            ? "increase"
            : "enter"
          : decisionOutput.targetExposure <= 0.01
            ? "exit"
            : "reduce"
        : decisionOutput.targetExposure > 0.01
          ? "enter"
          : "hold";
    // Reasons are ordered by authority: data and approval gates precede the
    // strategy-specific paper policy, account availability, and global policy.
    const blockReasons = hasStaleData
      ? ["stale_data"]
      : run.status === "paper" && !paperAutomationSupported
        ? ["strategy_shadow_only"]
      : run.status === "paper" && !paperApproval
        ? ["approval_missing"]
        : paperDraft && !paperDraft.allowed
          ? paperDraft.reasons
          : paperRiskPolicy && !paperRiskPolicy.allowed
            ? paperRiskPolicy.reasons
            : paperAccountError
              ? ["account_data_unavailable"]
              : paperOperationsPolicy && !paperOperationsPolicy.allowed
                ? paperOperationsPolicy.reasons
                : [];
    const decision = blockReasons.length
      ? "block"
      : paperDraft?.order
        ? intendedAction
        : intendedAction === "enter" && run.status === "paper"
          ? "hold"
          : intendedAction;
    recordStrategySpan(actor, {
      traceId,
      name: "strategy.risk_policy",
      startedAt: riskStartedAt,
      endedAt: Date.now(),
      attributes: {
        runId: run.id,
        symbol,
        mode: run.status,
        allowed: !blockReasons.length,
        reasons: blockReasons,
        intendedAction,
        targetExposure: decisionOutput.targetExposure,
        spreadBps: quote.spreadBps,
        paperPolicy: paperRiskPolicy
          ? {
              allowed: paperRiskPolicy.allowed,
              reasons: paperRiskPolicy.reasons,
            }
          : null,
        operationalPolicy: paperOperationsPolicy
          ? {
              allowed: paperOperationsPolicy.allowed,
              reasons: paperOperationsPolicy.reasons,
            }
          : null,
      },
    });
    const decisionId = crypto.randomUUID(),
      receiptId = crypto.randomUUID();
    let order: any = null,
      orderError: string | null = null,
      clientOrderId: string | null = null;
    if (
      run.status === "paper" &&
      paperDraft?.allowed &&
      paperDraft.order &&
      (!paperRiskPolicy || paperRiskPolicy.allowed) &&
      (!paperOperationsPolicy || paperOperationsPolicy.allowed)
    ) {
      clientOrderId = crypto.randomUUID();
      const orderStartedAt = Date.now();
      try {
        order =
          paperDraft.order.side === "buy"
            ? await alpaca.trading.orders.market({
                symbol,
                side: "buy",
                notional: paperDraft.order.notional,
                timeInForce: paperDraft.order.timeInForce,
                clientOrderId,
              })
            : await alpaca.trading.orders.market({
                symbol,
                side: "sell",
                qty: paperDraft.order.qty,
                timeInForce: paperDraft.order.timeInForce,
                clientOrderId,
              });
      } catch (error) {
        console.error("strategy paper order submission failed", {
          runId: run.id,
          symbol,
          error: error instanceof Error ? error.message : String(error),
        });
        orderError = "Broker submission failed";
      }
      recordStrategySpan(actor, {
        traceId,
        name: "strategy.paper_order.submit",
        startedAt: orderStartedAt,
        endedAt: Date.now(),
        status: orderError ? "error" : "ok",
        error: orderError,
        attributes: {
          runId: run.id,
          symbol,
          side: paperDraft.order.side,
          notional: paperDraft.order.notional,
          qty: paperDraft.order.qty,
          timeInForce: paperDraft.order.timeInForce,
          brokerOrderId: order?.id,
          brokerStatus: order?.status,
        },
      });
    }
    const submittedOrder = Boolean(order?.id);
    const finalDecision = orderError ? "block" : decision;
    const finalReasons = orderError ? ["broker_order_rejected"] : blockReasons;
    const targetWithinBand = Boolean(
      paperDraft &&
      (paperDraft.reasons as string[]).includes("target_within_band"),
    );
    const paperPolicyBlocked = Boolean(
      paperRiskPolicy && !paperRiskPolicy.allowed,
    );
    const operationalPolicyBlocked = Boolean(
      paperOperationsPolicy && !paperOperationsPolicy.allowed,
    );
    store.strategyDecision({
      id: decisionId,
      traceId,
      runId: run.id,
      symbol,
      decision: finalDecision,
      features: decisionOutput.features ?? {},
      weights: decisionOutput.weights ?? {},
      thresholds: decisionOutput.thresholds ?? config.params ?? {},
      riskChecks: {
        allowed: finalReasons.length === 0,
        mode: run.status,
        trigger,
        submittedOrder,
        reasons: finalReasons,
        intendedAction,
        paper:
          run.status === "paper"
            ? {
                currentNotional: paperState.netNotional,
                spreadBps: quote.spreadBps,
                draftOrder: paperDraft?.order ?? null,
                orderError,
                clientOrderId,
                riskPolicy: paperRiskPolicy
                  ? {
                      allowed: paperRiskPolicy.allowed,
                      reasons: paperRiskPolicy.reasons,
                      evidence: paperRiskPolicy.evidence,
                    }
                  : null,
                operationalPolicy: paperOperationsPolicy,
                accountError: paperAccountError,
              }
            : null,
        strategyPlugin: {
          id: strategy.id,
          version: strategy.version,
          risk: decisionOutput.risk,
          orders: decisionOutput.orders,
          attribution: decisionOutput.attribution,
        },
      },
      dataSnapshotIds: snapshotResult.records.map((record) => record.id),
      rawSignal: decisionOutput.risk.rawTargetExposure,
      riskAdjustedSignal: finalReasons.length
        ? 0
        : decisionOutput.risk.riskAdjustedSignal,
      targetPosition: finalReasons.length ? 0 : decisionOutput.targetExposure,
      reason: orderError
        ? `Paper order was blocked by broker response: ${orderError}`
        : hasStaleData
          ? `Blocked by stale crypto market data; intended action was ${intendedAction}.`
          : paperPolicyBlocked
            ? `Blocked by crypto paper risk policy: ${finalReasons.join(", ")}.`
            : operationalPolicyBlocked
              ? `Blocked by global operations policy: ${finalReasons.join(", ")}.`
              : targetWithinBand
                ? "Approved paper run is already within the target exposure band."
                : decisionOutput.reason,
      provenance,
      draftOrder: paperDraft?.order ?? undefined,
      paperOrderId: order?.id ?? null,
    });
    const asOf = new Date().toISOString();
    recordStrategyMetricRows(
      buildStrategyDecisionMetrics({
        runId: run.id,
        asOf,
        tickLatencyMs: Date.now() - tickStartedAt,
        snapshots: snapshotResult.records,
        decision: finalDecision,
        submittedOrder,
        orderStatus: order?.status ?? null,
        spreadBps: quote.spreadBps,
        slippageBps: paperOrderSlippageBps(order, referencePrice),
      }),
    );
    recordStrategySpan(actor, {
      traceId,
      name: "strategy.decision",
      startedAt: riskStartedAt,
      endedAt: Date.now(),
      attributes: {
        runId: run.id,
        symbol,
        decision: finalDecision,
        intendedAction,
        submittedOrder,
        reasonCount: finalReasons.length,
      },
    });
    if (order?.id && paperDraft?.order) {
      store.strategyOrder({
        id: crypto.randomUUID(),
        runId: run.id,
        decisionId,
        paperOrderId: order.id,
        status: order.status,
        payload: {
          ...paperDraft.order,
          clientOrderId,
          submittedAt: asOf,
          broker: managedOrderDto(order),
          referencePrice,
        },
      });
      reporting.recordOrderMetrics(run.id, store.strategyOrders(run.id), asOf);
    }
    if (trigger === "scheduler" && normalizeStrategySchedule(run.config)) {
      const nextConfig = withNextStrategySchedule(run.config, new Date());
      const nextConfigHash = await strategyConfigHash(nextConfig);
      const beforeRun = store.getStrategyRun(run.id) ?? run;
      if (store.updateStrategyRunConfig(run.id, nextConfig, nextConfigHash))
        recordStrategyAudit(
          actor,
          "schedule_advanced",
          "strategy_schedule",
          beforeRun,
          store.getStrategyRun(run.id),
          { trigger },
        );
    }
    const trace = store.getStrategyDecisionTrace(traceId);
    store.receipt(receiptId, {
      advisor: actor,
      kind:
        run.status === "paper"
          ? "strategy_paper_decision"
          : "strategy_shadow_decision",
      runId: run.id,
      traceId,
      decisionId,
      symbol,
      decision: finalDecision,
      submittedOrder,
      paperOrderId: order?.id ?? null,
      trigger,
      createdAt: asOf,
    });
    store.event(`strategy.${run.status}.tick`, actor, {
      runId: run.id,
      traceId,
      decisionId,
      symbol,
      decision: finalDecision,
      intendedAction,
      submittedOrder,
      paperOrderId: order?.id ?? null,
      targetExposure: decisionOutput.targetExposure,
      trigger,
    });
    recordStrategySpan(actor, {
      traceId,
      name: "strategy.tick",
      startedAt: tickStartedAt,
      endedAt: Date.now(),
      attributes: {
        runId: run.id,
        symbol,
        mode: run.status,
        trigger,
        decision: finalDecision,
        submittedOrder,
      },
    });
    return { runId: run.id, traceId, decisionId, receiptId, trace };
  }

  async function evaluateDueShadowStrategies(actor: string) {
    const now = new Date(),
      runs = store.strategyRuns(100);
    const dueRuns = runs.filter((run) =>
      strategyRunIsDue(
        run,
        now,
        store.strategyDecisions(run.id, 1)[0]?.createdAt ?? null,
      ),
    );
    const results = [];
    for (const run of dueRuns) {
      try {
        results.push(await evaluateStrategyRun(run, actor, "scheduler"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const asOf = new Date().toISOString();
        recordStrategyMetricRows([buildStrategyErrorMetric(run.id, asOf)]);
        recordStrategySpan(actor, {
          traceId: crypto.randomUUID(),
          name: "strategy.scheduler.evaluate",
          startedAt: Date.now(),
          endedAt: Date.now(),
          status: "error",
          error: message,
          attributes: { runId: run.id, strategyId: run.strategyId },
        });
        store.event("strategy.scheduler.error", actor, {
          runId: run.id,
          error: message,
        });
        results.push({ runId: run.id, error: message });
      }
    }
    return {
      checked: runs.length,
      due: dueRuns.length,
      results,
      asOf: now.toISOString(),
    };
  }

  let strategySchedulerBusy = false;
  async function pollStrategyScheduler() {
    // Skip overlapping intervals; one slow broker tick must not evaluate the
    // same due run concurrently.
    if (strategySchedulerBusy) return;
    strategySchedulerBusy = true;
    try {
      const result = await evaluateDueShadowStrategies("strategy-scheduler");
      if (result.due)
        console.log(
          `Strategy scheduler evaluated ${result.due} due shadow run(s)`,
        );
    } catch (error) {
      console.error(
        "strategy scheduler failed",
        error instanceof Error ? error.message : error,
      );
    } finally {
      strategySchedulerBusy = false;
    }
  }

  return {
    codeIdentity,
    normalizeSymbols: normalizeStrategySymbols,
    definition: strategyDefinition,
    withoutAsOf,
    provenance: (input: Parameters<typeof strategyProvenance>[1]) =>
      strategyProvenance(codeIdentity, input),
    configHash: strategyConfigHash,
    recordAudit: recordStrategyAudit,
    cryptoPositionQty,
    latestCryptoOrderMarket,
    recordMetricRows: recordStrategyMetricRows,
    recordSpan: recordStrategySpan,
    evaluateRun: evaluateStrategyRun,
    evaluateDue: evaluateDueShadowStrategies,
    reconcileOrders: reporting.reconcileOrders,
    buildAttribution: reporting.buildAttribution,
    buildPerformance: reporting.buildPerformance,
    buildAlerts: reporting.buildAlerts,
    pollScheduler: pollStrategyScheduler,
  };
}
