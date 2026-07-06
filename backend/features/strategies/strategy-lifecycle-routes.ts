import { ClientError, json, requestJson } from "../../http/http";
import {
  parseStrategyParams,
  runBacktest,
  strategyFunctionFromPlugin,
  strategyPluginFromId,
  walkForwardWindows,
} from "./strategy-backtest";
import {
  parseWalkForwardRequest,
  runWalkForwardEvaluation,
} from "./strategy-walk-forward";
import {
  cryptoBarsDto,
  parseCryptoLookbackDays,
  parseCryptoTimeframe,
} from "./crypto-strategy-data";
import {
  parseStrategyPaperApproval,
  type StrategyPaperApproval,
} from "./strategy-paper";
import {
  parseStrategyReview,
  withStrategyReviewConfig,
} from "./strategy-review";
import {
  currentStrategyExperimentProtocol,
  parseStrategyExperimentProtocol,
  withStrategyExperimentProtocolConfig,
} from "./strategy-experiment-protocol";
import { parseStrategyIntervalMinutes } from "./strategy-scheduler";
import {
  canonicalHash,
  STRATEGY_BACKTEST_POLICY_VERSION,
  STRATEGY_FEATURE_SCHEMA_VERSION,
} from "./strategy-provenance";
import { buildStrategyBacktestComparison } from "./strategy-compare";
import type { StrategyRouteContext } from "./strategy-route-context";

/** Owns backtest creation and strategy-run lifecycle, scheduler, and admin mutations. */
export async function handleStrategyLifecycleRequest(
  request: Request,
  url: URL,
  context: StrategyRouteContext,
): Promise<Response | null> {
  const { alpaca, store, runtime, actor, allow } = context;
  if (url.pathname === "/api/strategy/backtests" && request.method === "POST") {
    if (!allow(`${actor}:strategy-backtest`, 20))
      return json({ error: "Strategy backtest rate limit exceeded" }, 429);
    const input = await requestJson(request);
    const strategyId = String(input.strategyId ?? "buy-and-hold");
    const datasetId = String(input.datasetId ?? "").trim() || null;
    const storedDataset = datasetId
      ? store.getStrategyBarDataset(datasetId)
      : null;
    if (datasetId && (!storedDataset || storedDataset.actor !== actor))
      throw new ClientError("Strategy dataset not found", 404);
    let symbols: string[],
      params: Record<string, unknown>,
      timeframe: string,
      days: number,
      trainSize: number,
      testSize: number,
      strategyPlugin,
      walkForwardRequest: ReturnType<typeof parseWalkForwardRequest>;
    try {
      symbols = runtime.normalizeSymbols(
        strategyId,
        input.symbols ?? storedDataset?.symbols,
      );
      params = parseStrategyParams(strategyId, input.params ?? {});
      strategyPlugin = strategyPluginFromId(strategyId, params);
      if (
        input.walkForward &&
        (input.trainSize !== undefined || input.testSize !== undefined)
      )
        throw new Error(
          "Use walkForward or legacy trainSize/testSize, not both",
        );
      walkForwardRequest = parseWalkForwardRequest(
        strategyId,
        input.walkForward,
      );
      trainSize = Number(input.trainSize ?? 0);
      testSize = Number(input.testSize ?? 0);
      if (
        (input.trainSize !== undefined || input.testSize !== undefined) &&
        (!Number.isInteger(trainSize) ||
          !Number.isInteger(testSize) ||
          trainSize < 2 ||
          testSize < 1)
      )
        throw new Error(
          "Legacy trainSize must be at least 2 and testSize at least 1",
        );
      timeframe = parseCryptoTimeframe(
        input.timeframe ?? storedDataset?.timeframe,
      );
      if (
        storedDataset &&
        (JSON.stringify(symbols) !== JSON.stringify(storedDataset.symbols) ||
          timeframe !== storedDataset.timeframe)
      )
        throw new Error("Backtest symbols and timeframe must match the stored dataset");
      days = storedDataset
        ? Math.min(
            90,
            Math.max(
              1,
              Math.ceil(
                (new Date(storedDataset.end).getTime() -
                  new Date(storedDataset.start).getTime()) /
                  86_400_000,
              ),
            ),
          )
        : parseCryptoLookbackDays(input.days);
    } catch (error) {
      throw new ClientError(
        error instanceof Error ? error.message : "Invalid backtest input",
        400,
      );
    }
    const initialCash = Number(input.initialCash ?? 10_000),
      feeBps = Number(input.feeBps ?? 0),
      slippageBps = Number(input.slippageBps ?? 5);
    const end = storedDataset ? new Date(storedDataset.end) : new Date(),
      start = storedDataset
        ? new Date(storedDataset.start)
        : new Date(end.getTime() - days * 86_400_000);
    const symbol = symbols[0]!;
    const providerBars = storedDataset
      ? Object.fromEntries(
          symbols.map((storedSymbol) => [
            storedSymbol,
            storedDataset.bars.filter(
              (bar: { symbol: string }) => bar.symbol === storedSymbol,
            ),
          ]),
        )
      : await alpaca.marketData.getCryptoBars({
          loc: "us",
          symbols,
          timeframe,
          start,
          end,
          limit: 10_000,
        } as any);
    const dataset = storedDataset
      ? {
          source: "Alpaca crypto historical bars",
          feed: storedDataset.feed,
          timeframe,
          start: storedDataset.start,
          end: storedDataset.end,
          symbols,
          bars: providerBars,
          asOf: storedDataset.createdAt,
        }
      : cryptoBarsDto({ symbols, timeframe, start, end, bars: providerBars });
    const barsBySymbol = dataset.bars;
    const bars = barsBySymbol[symbol] ?? [];
    const strategy = strategyFunctionFromPlugin(
      strategyPlugin,
      { histories: barsBySymbol },
      symbol,
    );
    const result = runBacktest({
      strategyId,
      bars,
      strategy,
      initialCash,
      feeBps,
      slippageBps,
    });
    const baselines = {
      cash: runBacktest({
        strategyId: "cash",
        bars,
        strategy: strategyFunctionFromPlugin(
          strategyPluginFromId("cash"),
          { histories: barsBySymbol },
          symbol,
        ),
        initialCash,
        feeBps,
        slippageBps,
      }),
      buyAndHold: runBacktest({
        strategyId: "buy-and-hold",
        bars,
        strategy: strategyFunctionFromPlugin(
          strategyPluginFromId("buy-and-hold"),
          { histories: barsBySymbol },
          symbol,
        ),
        initialCash,
        feeBps,
        slippageBps,
      }),
    };
    const walkForward =
      trainSize && testSize
        ? walkForwardWindows(bars, trainSize, testSize).map((window) => ({
            trainStart: window.trainStart,
            testStart: window.testStart,
            trainBars: window.train.length,
            testBars: window.test.length,
          }))
        : [];
    let walkForwardEvaluation = null;
    try {
      walkForwardEvaluation = walkForwardRequest
        ? runWalkForwardEvaluation({
            strategyId,
            symbol,
            bars,
            barsBySymbol,
            request: walkForwardRequest,
            initialCash,
            feeBps,
            slippageBps,
          })
        : null;
    } catch (error) {
      throw new ClientError(
        error instanceof Error
          ? error.message
          : "Invalid walk-forward evaluation",
        400,
      );
    }
    const definition = runtime.definition(
      symbols,
      strategyId,
      params,
      timeframe,
      days,
      datasetId,
    );
    const definitionHash = canonicalHash(definition);
    const provenance = runtime.provenance({
      pluginVersion: strategyPlugin.version,
      policyVersion: STRATEGY_BACKTEST_POLICY_VERSION,
      definitionHash,
      start,
      end,
      timeframe,
      symbols,
      datasetHash:
        storedDataset?.datasetHash ??
        canonicalHash(runtime.withoutAsOf(dataset)),
    });
    const backtestId = crypto.randomUUID();
    const output = {
      source: dataset.source,
      feed: dataset.feed,
      symbol,
      symbols,
      timeframe,
      start: dataset.start,
      end: dataset.end,
      result,
      baselines,
      walkForward,
      walkForwardEvaluation,
      datasetId,
      asOf: dataset.asOf,
    };
    store.strategyBacktest({
      id: backtestId,
      actor,
      strategyId,
      definitionHash,
      provenance,
      request: {
        ...definition,
        initialCash,
        feeBps,
        slippageBps,
        trainSize,
        testSize,
        walkForward: walkForwardRequest,
        datasetId,
      },
      result: output,
    });
    store.event("strategy.backtest.completed", actor, {
      backtestId,
      strategyId,
      symbol,
      timeframe,
      days,
      datasetHash: provenance.datasetHash,
      totalReturnPercent: result.totalReturnPercent,
      bars: bars.length,
      datasetId,
      walkForwardFolds: walkForwardEvaluation?.aggregate.foldCount ?? 0,
    });
    return json({ backtestId, provenance, ...output }, 201);
  }
  if (
    url.pathname === "/api/strategy/backtests/compare" &&
    request.method === "POST"
  ) {
    if (!allow(`${actor}:strategy-backtest-compare`, 20))
      return json(
        { error: "Strategy backtest compare rate limit exceeded" },
        429,
      );
    const input = await requestJson(request);
    const ids: string[] = Array.isArray(input.backtestIds)
      ? input.backtestIds.map((id: unknown) => String(id).trim())
      : [];
    const uniqueIds = [...new Set(ids)];
    if (
      uniqueIds.length !== ids.length ||
      uniqueIds.length < 2 ||
      uniqueIds.length > 20 ||
      uniqueIds.some((id) => !id)
    )
      throw new ClientError(
        "Compare requires 2 to 20 unique backtestIds",
        400,
      );
    const backtests = uniqueIds.map((id) => store.getStrategyBacktest(id));
    if (backtests.some((backtest) => !backtest || backtest.actor !== actor))
      throw new ClientError("Strategy backtest not found", 404);
    return json(
      buildStrategyBacktestComparison({
        backtests: backtests as NonNullable<(typeof backtests)[number]>[],
      }),
    );
  }
  const strategyBacktestMatch =
    request.method === "GET" &&
    url.pathname.match(/^\/api\/strategy\/backtests\/([^/]+)$/);
  if (strategyBacktestMatch) {
    const backtest = store.getStrategyBacktest(
      decodeURIComponent(strategyBacktestMatch[1]!),
    );
    return backtest && backtest.actor === actor
      ? json(backtest)
      : json({ error: "Strategy backtest not found" }, 404);
  }
  if (url.pathname === "/api/strategy/runs" && request.method === "GET")
    return json({ runs: store.strategyRuns(), asOf: new Date().toISOString() });
  if (url.pathname === "/api/strategy/runs" && request.method === "POST") {
    if (!allow(`${actor}:strategy-runs`, 10))
      return json({ error: "Strategy run rate limit exceeded" }, 429);
    const input = await requestJson(request);
    const strategyId = String(input.strategyId ?? "");
    const datasetId = String(input.datasetId ?? "").trim() || null;
    const storedDataset = datasetId
      ? store.getStrategyBarDataset(datasetId)
      : null;
    if (datasetId && (!storedDataset || storedDataset.actor !== actor))
      throw new ClientError("Strategy dataset not found", 404);
    let symbols: string[],
      params: Record<string, unknown>,
      timeframe: string,
      days: number,
      strategyPlugin;
    try {
      symbols = runtime.normalizeSymbols(
        strategyId,
        input.symbols ?? storedDataset?.symbols,
      );
      params = parseStrategyParams(strategyId, input.params ?? {});
      strategyPlugin = strategyPluginFromId(strategyId, params);
      timeframe = parseCryptoTimeframe(
        input.timeframe ?? storedDataset?.timeframe,
      );
      if (
        storedDataset &&
        (JSON.stringify(symbols) !== JSON.stringify(storedDataset.symbols) ||
          timeframe !== storedDataset.timeframe)
      )
        throw new Error("Run symbols and timeframe must match the stored dataset");
      days = storedDataset ? 90 : parseCryptoLookbackDays(input.days);
    } catch (error) {
      throw new ClientError(
        error instanceof Error
          ? error.message
          : "Invalid strategy run configuration",
        400,
      );
    }
    let intervalMinutes: number | null;
    try {
      intervalMinutes = parseStrategyIntervalMinutes(
        input.intervalMinutes ?? input.schedule?.intervalMinutes,
      );
    } catch (error) {
      throw new ClientError(
        error instanceof Error ? error.message : "Invalid strategy schedule",
        400,
      );
    }
    const backtestId = String(input.backtestId ?? "").trim();
    if (!backtestId)
      throw new ClientError("A reviewed backtestId is required", 400);
    const backtest = store.getStrategyBacktest(backtestId);
    if (!backtest || backtest.actor !== actor)
      throw new ClientError("Strategy backtest not found", 404);
    if (!backtest.comparable)
      throw new ClientError(
        "Backtests from a dirty working tree cannot seed a comparable strategy run",
        409,
      );
    const definitionHash = canonicalHash(
      runtime.definition(
        symbols,
        strategyId,
        params,
        timeframe,
        days,
        datasetId,
      ),
    );
    if (
      backtest.definitionHash !== definitionHash ||
      backtest.provenance.pluginVersion !== strategyPlugin.version ||
      backtest.provenance.gitCommit !== runtime.codeIdentity.gitCommit ||
      backtest.provenance.featureSchemaVersion !==
        STRATEGY_FEATURE_SCHEMA_VERSION
    )
      throw new ClientError(
        "Strategy run code or configuration does not match the reviewed backtest",
        409,
      );
    const runId = crypto.randomUUID();
    const schedule = intervalMinutes
      ? { enabled: true, intervalMinutes, nextRunAt: new Date().toISOString() }
      : undefined;
    const config = {
      symbols,
      strategyId,
      params,
      timeframe,
      days,
      mode: "shadow",
      backtestId,
      ...(datasetId ? { datasetId } : {}),
      ...(schedule ? { schedule } : {}),
    };
    const configHash = await runtime.configHash(config);
    const provenance = runtime.provenance({
      pluginVersion: strategyPlugin.version,
      policyVersion: "crypto-shadow-v1",
      definitionHash,
      start: new Date(backtest.provenance.query.start),
      end: new Date(backtest.provenance.query.end),
      timeframe,
      symbols,
      datasetHash: backtest.provenance.datasetHash,
    });
    store.createStrategyRun({
      id: runId,
      backtestId,
      strategyId,
      strategyVersion: strategyPlugin.version,
      status: "shadow",
      configHash,
      policyVersion: "crypto-shadow-v1",
      symbols,
      budget: 0,
      config,
      provenance,
      notes: String(input.notes ?? "") || null,
    });
    runtime.recordAudit(
      actor,
      "run_created",
      "strategy_run",
      null,
      store.getStrategyRun(runId),
      {
        mode: "shadow",
        intervalMinutes,
        pluginVersion: strategyPlugin.version,
        backtestId,
        datasetHash: provenance.datasetHash,
      },
    );
    store.event("strategy.run.created", actor, {
      runId,
      backtestId,
      strategyId,
      symbols,
      mode: "shadow",
      intervalMinutes,
      datasetHash: provenance.datasetHash,
    });
    return json({ runId, ...store.getStrategyRun(runId) }, 201);
  }
  if (
    url.pathname === "/api/strategy/scheduler/tick" &&
    request.method === "POST"
  ) {
    if (!allow(`${actor}:strategy-scheduler`, 10))
      return json({ error: "Strategy scheduler rate limit exceeded" }, 429);
    return json(await runtime.evaluateDue(actor));
  }
  const strategyProtocolMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/experiment-protocol$/,
  );
  if (strategyProtocolMatch && request.method === "POST") {
    if (!allow(`${actor}:strategy-experiment-protocol`, 10))
      return json(
        { error: "Strategy experiment protocol rate limit exceeded" },
        429,
      );
    const runId = decodeURIComponent(strategyProtocolMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    if (!["shadow", "paused"].includes(run.status))
      return json(
        {
          error:
            "Only shadow or paused runs can register a paper experiment protocol",
        },
        409,
      );
    const input = await requestJson(request);
    let protocol: ReturnType<typeof parseStrategyExperimentProtocol>;
    try {
      protocol = parseStrategyExperimentProtocol(input, {
        actor,
        config: run.config,
      });
    } catch (error) {
      throw new ClientError(
        error instanceof Error
          ? error.message
          : "Invalid strategy experiment protocol",
        400,
      );
    }
    const config = withStrategyExperimentProtocolConfig(run.config, protocol);
    store.updateStrategyRunConfig(
      runId,
      config,
      await runtime.configHash(config),
    );
    runtime.recordAudit(
      actor,
      "experiment_protocol_registered",
      "strategy_experiment_protocol",
      run,
      store.getStrategyRun(runId),
      {
        version: protocol.version,
        protocolHash: protocol.protocolHash,
        startAt: protocol.startAt,
        stopAt: protocol.stopAt,
        maximumBudget: protocol.maximumBudget,
      },
    );
    store.strategyNote(
      runId,
      actor,
      `Registered paper experiment protocol v${protocol.version} through ${protocol.stopAt}.`,
    );
    store.event("strategy.experiment_protocol.registered", actor, {
      runId,
      version: protocol.version,
      protocolHash: protocol.protocolHash,
    });
    return json({ runId, protocol, ...store.getStrategyRun(runId) });
  }
  const strategyPaperApprovalMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/paper-approval$/,
  );
  if (strategyPaperApprovalMatch && request.method === "POST") {
    if (!allow(`${actor}:strategy-paper-approval`, 5))
      return json(
        { error: "Strategy paper approval rate limit exceeded" },
        429,
      );
    const runId = decodeURIComponent(strategyPaperApprovalMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    if (!["shadow", "paused"].includes(run.status))
      return json(
        {
          error:
            "Only shadow or paused runs can be approved for paper automation",
        },
        409,
      );
    const input = await requestJson(request);
    let approval: StrategyPaperApproval;
    try {
      approval = parseStrategyPaperApproval(input, actor);
    } catch (error) {
      throw new ClientError(
        error instanceof Error ? error.message : "Invalid paper approval",
        400,
      );
    }
    const protocol = currentStrategyExperimentProtocol(run.config);
    if (!protocol)
      return json(
        {
          error:
            "Strategy paper approval requires a pre-registered experiment protocol",
        },
        409,
      );
    if (approval.budget > protocol.maximumBudget)
      throw new ClientError(
        "Paper approval budget exceeds the registered protocol maximum budget",
        400,
      );
    if (
      new Date(approval.expiresAt).getTime() >
      new Date(protocol.stopAt).getTime()
    )
      throw new ClientError(
        "Paper approval expiry must not exceed the registered protocol stop date",
        400,
      );
    approval = {
      ...approval,
      experimentProtocol: {
        version: protocol.version,
        protocolHash: protocol.protocolHash,
        startAt: protocol.startAt,
        stopAt: protocol.stopAt,
        minimumObservations: protocol.minimumObservations,
        maximumBudget: protocol.maximumBudget,
        reviewCadenceDays: protocol.reviewCadenceDays,
      },
    };
    const config = {
      ...(run.config as Record<string, unknown>),
      mode: "paper",
      paperApproval: approval,
    };
    const configHash = await runtime.configHash(config);
    if (
      !store.approveStrategyRunPaper(runId, approval.budget, config, configHash)
    )
      return json({ error: "Strategy run could not be approved" }, 409);
    runtime.recordAudit(
      actor,
      "paper_approved",
      "paper_approval",
      run,
      store.getStrategyRun(runId),
      {
        expiresAt: approval.expiresAt,
        budget: approval.budget,
        riskPolicy: approval.riskPolicy,
      },
    );
    store.strategyNote(
      runId,
      actor,
      `Approved paper automation until ${approval.expiresAt} with budget ${approval.budget}.`,
    );
    store.event("strategy.paper.approved", actor, {
      runId,
      approval: { ...approval, approvedBy: actor },
    });
    return json({ runId, ...store.getStrategyRun(runId) });
  }
  const strategyPauseMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/pause$/,
  );
  if (strategyPauseMatch && request.method === "POST") {
    const runId = decodeURIComponent(strategyPauseMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    const input = await requestJson(request).catch(() => ({}));
    const reason = String(input.reason ?? "Paused from Strategy Lab").slice(
      0,
      200,
    );
    store.updateStrategyRunStatus(runId, "paused", reason);
    runtime.recordAudit(
      actor,
      "status_changed",
      "strategy_status",
      run,
      store.getStrategyRun(runId),
      { reason, status: "paused" },
    );
    store.strategyNote(runId, actor, reason);
    store.event("strategy.run.paused", actor, { runId, reason });
    return json({ runId, ...store.getStrategyRun(runId) });
  }
  const strategyKillMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/kill$/,
  );
  if (strategyKillMatch && request.method === "POST") {
    const runId = decodeURIComponent(strategyKillMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    const input = await requestJson(request).catch(() => ({}));
    const reason = String(
      input.reason ?? "Kill switch activated from Strategy Lab",
    ).slice(0, 200);
    const config = {
      ...(run.config as Record<string, unknown>),
      paperApproval: {
        ...((run.config as { paperApproval?: Record<string, unknown> })
          .paperApproval ?? {}),
        killSwitch: { activatedAt: new Date().toISOString(), reason },
      },
    };
    store.updateStrategyRunConfig(
      runId,
      config,
      await runtime.configHash(config),
    );
    store.updateStrategyRunStatus(runId, "retired", reason);
    runtime.recordAudit(
      actor,
      "kill_switch",
      "strategy_config",
      run,
      store.getStrategyRun(runId),
      { reason, status: "retired" },
    );
    store.strategyNote(runId, actor, reason);
    store.event("strategy.run.kill_switch", actor, { runId, reason });
    return json({ runId, ...store.getStrategyRun(runId) });
  }
  const strategyReviewMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/review$/,
  );
  if (strategyReviewMatch && request.method === "POST") {
    if (!allow(`${actor}:strategy-review`, 10))
      return json({ error: "Strategy review rate limit exceeded" }, 429);
    const runId = decodeURIComponent(strategyReviewMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    const input = await requestJson(request);
    let parsed: ReturnType<typeof parseStrategyReview>;
    try {
      parsed = parseStrategyReview(input, actor, run.status);
    } catch (error) {
      throw new ClientError(
        error instanceof Error ? error.message : "Invalid strategy review",
        400,
      );
    }
    let config = withStrategyReviewConfig(run.config, parsed.review);
    if (parsed.action === "retire") {
      const approval =
        config.paperApproval &&
        typeof config.paperApproval === "object" &&
        !Array.isArray(config.paperApproval)
          ? config.paperApproval
          : {};
      config = {
        ...config,
        paperApproval: {
          ...approval,
          killSwitch: {
            activatedAt: parsed.review.reviewedAt,
            reason: parsed.note,
          },
        },
      };
    }
    store.updateStrategyRunConfig(
      runId,
      config,
      await runtime.configHash(config),
    );
    store.updateStrategyRunStatus(
      runId,
      parsed.status,
      `${parsed.action}: ${parsed.note}`,
    );
    runtime.recordAudit(
      actor,
      "reviewed",
      "strategy_review",
      run,
      store.getStrategyRun(runId),
      { action: parsed.action, status: parsed.status, note: parsed.note },
    );
    store.strategyNote(
      runId,
      actor,
      `${parsed.action.toUpperCase()}: ${parsed.note}`,
    );
    store.event("strategy.run.reviewed", actor, {
      runId,
      action: parsed.action,
      status: parsed.status,
    });
    return json({ runId, ...store.getStrategyRun(runId) });
  }

  return null;
}
