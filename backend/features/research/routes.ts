import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { ClientError, json, requestJson } from "../../http/http";
import { localResponseTimeFields } from "../../shared/time-provenance";
import {
  getFinnhubCompanyEnrichment,
  type FinnhubCompanyEnrichment,
} from "../../integrations/finnhub";
import {
  getGdeltCompanySignals,
  type GdeltCompanySignals,
} from "../../integrations/gdelt";
import {
  getOfficialMacroContext,
  type MacroContext,
} from "../../integrations/macro-context";
import {
  getOpenFigiIdentity,
  type OpenFigiIdentity,
} from "../../integrations/openfigi";
import type { createStore } from "../../persistence/store";
import {
  appendTradeJournalReview,
  createTradeJournalEntry,
  journalCandidateFromReceipt,
  TradeJournalCreateInput,
  TradeJournalReviewInput,
} from "../portfolio/trade-journal";
import {
  Intent,
  PortfolioQuestion,
  runPortfolioCopilot,
  runPortfolioQuestion,
} from "./copilot";
import { buildFixedIncomeResearchStatus } from "./fixed-income-research";
import {
  buildFinnhubResearchCoverage,
  buildGdeltResearchCoverage,
  buildMacroResearchCoverage,
  buildOpenFigiResearchCoverage,
  buildSecResearchCoverage,
} from "./provider-coverage";
import { normalizeSecPointInTimeDate } from "./sec-financial-trends";
import {
  getCompanySecEvidence,
  getComparableValuations,
  getPointInTimeComparableValuations,
  getValuationScenarios,
  openaiModel,
  replayCompanyResearch,
  runCompanyResearch,
} from "./research";
import {
  buildComparableValuationReplay,
  parseComparableSymbols,
  replayComparableValuation,
} from "./comparable-valuation";
import {
  buildValuationScenarioReplay,
  replayValuationScenario,
  ValuationScenarioInput,
} from "./valuation-scenario";

type Env = Record<string, string | undefined>;
type Store = ReturnType<typeof createStore>;
type RateLimit = (key: string, maximum: number) => boolean;
type SecCompanyEvidence = Awaited<ReturnType<typeof getCompanySecEvidence>>;
type ComparableValuations = Awaited<ReturnType<typeof getComparableValuations>>;
type ValuationScenarios = Awaited<ReturnType<typeof getValuationScenarios>>;
type CompanyResearchRun = Awaited<ReturnType<typeof runCompanyResearch>>;
type PortfolioQuestionRun = Awaited<ReturnType<typeof runPortfolioQuestion>>;
type PortfolioCopilotRun = Awaited<ReturnType<typeof runPortfolioCopilot>>;

type ResearchContext = {
  alpaca: Alpaca;
  store: Store;
  actor: string;
  allow: RateLimit;
  env?: Env;
  finnhubCompanyEnrichment?: (
    symbol: string,
  ) => Promise<FinnhubCompanyEnrichment>;
  gdeltCompanySignals?: (
    symbol: string,
    companyName: string,
  ) => Promise<GdeltCompanySignals>;
  openFigiIdentity?: (
    symbol: string,
    companyName: string,
  ) => Promise<OpenFigiIdentity>;
  secCompanyEvidence?: (
    symbol: string,
    filedThrough: string | null,
  ) => Promise<SecCompanyEvidence>;
  officialMacroContext?: () => Promise<MacroContext>;
  comparableValuations?: (
    symbol: string,
    peers: string | string[],
  ) => Promise<ComparableValuations>;
  pointInTimeComparableValuations?: (
    symbol: string,
    peers: string | string[],
    asOf: string,
  ) => Promise<ComparableValuations>;
  valuationScenarios?: (
    symbol: string,
    scenarios: unknown,
  ) => Promise<ValuationScenarios>;
  companyResearch?: (
    symbol: string,
    runId: string,
  ) => Promise<CompanyResearchRun>;
  portfolioQuestion?: (
    alpaca: Alpaca,
    question: string,
  ) => Promise<PortfolioQuestionRun>;
  portfolioCopilot?: (
    alpaca: Alpaca,
    intent: Intent,
  ) => Promise<PortfolioCopilotRun>;
};

const symbolFrom = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toUpperCase();
const validSymbol = (symbol: string) => /^[A-Z.]{1,10}$/.test(symbol);

/** Handles portfolio-advisor plans and company-research endpoints. */
export async function handleResearchRequest(
  request: Request,
  url: URL,
  context: ResearchContext,
): Promise<Response | null> {
  if (
    !url.pathname.startsWith("/api/agent/") &&
    !url.pathname.startsWith("/api/research/") &&
    !url.pathname.startsWith("/api/trade-journal")
  ) {
    return null;
  }

  const { alpaca, store, actor, allow } = context;
  const env = context.env ?? process.env;

  if (url.pathname === "/api/agent/plans" && request.method === "POST") {
    if (!allow(`${actor}:agent`, 10))
      return json({ error: "Agent rate limit exceeded" }, 429);
    if (!env.OPENAI_API_KEY)
      return json(
        { error: "Add OPENAI_API_KEY to .env to enable the agent" },
        503,
      );
    const parsed = Intent.safeParse((await requestJson(request)).intent);
    if (!parsed.success) {
      return json(
        {
          error:
            "Intent must be reduce_concentration, balanced_growth, or preserve_capital",
        },
        400,
      );
    }
    const planId = crypto.randomUUID();
    const output = await (context.portfolioCopilot ?? runPortfolioCopilot)(
      alpaca,
      parsed.data,
    );
    store.plan(planId, parsed.data, output, actor);
    const auditHash =
      store.decisionAuditTrail(planId).at(-1)?.entryHash ?? null;
    store.event("agent.plan.created", actor, {
      planId,
      intent: parsed.data,
      ideas: output.ideas.length,
      auditHash,
    });
    return json({ planId, intent: parsed.data, auditHash, ...output });
  }

  if (url.pathname === "/api/agent/questions" && request.method === "POST") {
    if (!allow(`${actor}:portfolio-question`, 20)) {
      return json({ error: "Portfolio Q&A rate limit exceeded" }, 429);
    }
    if (!env.OPENAI_API_KEY) {
      return json(
        { error: "Add OPENAI_API_KEY to .env to enable portfolio Q&A" },
        503,
      );
    }
    const parsed = PortfolioQuestion.safeParse(
      (await requestJson(request)).question,
    );
    if (!parsed.success) {
      return json(
        { error: "Question must be between 3 and 500 characters" },
        400,
      );
    }
    const output = await (context.portfolioQuestion ?? runPortfolioQuestion)(
      alpaca,
      parsed.data,
    );
    store.event("agent.portfolio_question.answered", actor, {
      evidence: [...new Set(output.claims.flatMap((claim) => claim.evidence))],
      claims: output.claims.length,
    });
    return json({
      question: parsed.data,
      ...output,
    });
  }

  if (
    url.pathname.startsWith("/api/agent/plans/") &&
    request.method === "GET"
  ) {
    const plan = store.getPlan(url.pathname.split("/").pop() ?? "");
    return plan ? json(plan) : json({ error: "Plan not found" }, 404);
  }

  if (url.pathname === "/api/trade-journal" && request.method === "GET") {
    const entries = store.tradeJournalEntries();
    const journaledReceipts = new Set(entries.map((entry) => entry.receiptId));
    const eligibleReceipts = store
      .receipts(100)
      .map((receipt) => journalCandidateFromReceipt(receipt.id, receipt))
      .filter(
        (candidate) =>
          candidate !== null && !journaledReceipts.has(candidate.receiptId),
      );
    return json({
      entries,
      eligibleReceipts,
      ...localResponseTimeFields(new Date()),
    });
  }

  if (url.pathname === "/api/trade-journal" && request.method === "POST") {
    if (!allow(`${actor}:trade-journal-create`, 30)) {
      return json({ error: "Trade journal rate limit exceeded" }, 429);
    }
    const parsed = TradeJournalCreateInput.safeParse(
      await requestJson(request),
    );
    if (!parsed.success) {
      return json(
        { error: "Receipt, thesis, and invalidation are required" },
        400,
      );
    }
    if (store.tradeJournalEntryForReceipt(parsed.data.receiptId)) {
      return json({ error: "This receipt already has a journal entry" }, 409);
    }
    const receipt = store.getReceipt(parsed.data.receiptId);
    if (!receipt) return json({ error: "Receipt not found" }, 404);
    const candidate = journalCandidateFromReceipt(
      parsed.data.receiptId,
      receipt,
    );
    if (!candidate) {
      return json(
        {
          error:
            "Only standard stock-order receipts can start a trade journal entry",
        },
        400,
      );
    }
    const entry = createTradeJournalEntry(candidate, parsed.data, actor);
    store.addTradeJournalEntry(entry, actor);
    store.event("trade_journal.created", actor, {
      journalId: entry.id,
      receiptId: entry.receiptId,
      orderId: entry.orderId,
      symbol: entry.symbol,
      side: entry.side,
    });
    return json({ entry }, 201);
  }

  const tradeJournalReviewMatch = url.pathname.match(
    /^\/api\/trade-journal\/([^/]+)\/reviews$/,
  );
  if (tradeJournalReviewMatch && request.method === "POST") {
    if (!allow(`${actor}:trade-journal-review`, 60)) {
      return json({ error: "Trade journal rate limit exceeded" }, 429);
    }
    const journalId = decodeURIComponent(tradeJournalReviewMatch[1]!);
    const current = store.getTradeJournalEntry(journalId);
    if (!current) {
      return json({ error: "Trade journal entry not found" }, 404);
    }
    const parsed = TradeJournalReviewInput.safeParse(
      await requestJson(request),
    );
    if (!parsed.success) {
      return json(
        { error: "A thesis status and review note are required" },
        400,
      );
    }
    if (current.status === "closed") {
      return json(
        { error: "Closed journal entries cannot be reviewed again" },
        409,
      );
    }
    const [currentPrice, positions] = await Promise.all([
      alpaca.marketData.getLatestPrice(current.symbol),
      alpaca.trading.positions.getAllOpenPositions(),
    ]);
    if (
      typeof currentPrice !== "number" ||
      !Number.isFinite(currentPrice) ||
      currentPrice <= 0
    ) {
      return json(
        { error: "No valid current price is available for this review" },
        502,
      );
    }
    const rawPosition = positions.find(
      (position) => position.symbol === current.symbol,
    );
    const numberOrNull = (value: unknown) => {
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    };
    const rawReturn = numberOrNull(rawPosition?.unrealizedPlpc);
    const position = rawPosition
      ? {
          qty: numberOrNull(rawPosition.qty),
          averageEntryPrice: numberOrNull(rawPosition.avgEntryPrice),
          currentPrice: numberOrNull(rawPosition.currentPrice),
          marketValue: numberOrNull(rawPosition.marketValue),
          unrealizedProfitLoss: numberOrNull(rawPosition.unrealizedPl),
          unrealizedReturnPercent: rawReturn === null ? null : rawReturn * 100,
        }
      : null;
    const receipt = store.getReceipt(current.receiptId);
    const observedAt = new Date().toISOString();
    const entry = appendTradeJournalReview(
      current,
      parsed.data,
      {
        currentPrice,
        observedAt,
        receiptStatus: String(receipt?.status ?? "unknown"),
        position,
      },
      actor,
      observedAt,
    );
    store.updateTradeJournalEntry(entry, actor);
    store.event("trade_journal.reviewed", actor, {
      journalId: entry.id,
      receiptId: entry.receiptId,
      symbol: entry.symbol,
      status: entry.status,
      reviewId: entry.reviews.at(-1)!.id,
    });
    return json({ entry });
  }

  if (url.pathname === "/api/research/sec" && request.method === "GET") {
    if (!allow(`${actor}:sec-research`, 30))
      return json({ error: "SEC research rate limit exceeded" }, 429);
    const symbol = symbolFrom(url.searchParams.get("symbol"));
    if (!validSymbol(symbol))
      return json({ error: "A valid stock symbol is required" }, 400);
    const requestedAsOf = url.searchParams.get("asOf");
    let filedThrough: string | null = null;
    if (requestedAsOf) {
      try {
        filedThrough = normalizeSecPointInTimeDate(
          requestedAsOf,
          new Date().toISOString().slice(0, 10),
        );
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Invalid SEC point-in-time date",
          },
          400,
        );
      }
    }
    const result = await (
      context.secCompanyEvidence ??
      ((requestedSymbol, cutoff) =>
        getCompanySecEvidence(
          requestedSymbol,
          undefined,
          undefined,
          cutoff,
        ))
    )(symbol, filedThrough);
    return json({ ...result, quality: buildSecResearchCoverage(result) });
  }

  if (url.pathname === "/api/research/macro" && request.method === "GET") {
    if (!allow(`${actor}:macro-research`, 30))
      return json({ error: "Macro research rate limit exceeded" }, 429);
    const result = await (
      context.officialMacroContext ?? getOfficialMacroContext
    )();
    return json({ ...result, quality: buildMacroResearchCoverage(result) });
  }

  if (
    url.pathname === "/api/research/fixed-income" &&
    request.method === "GET"
  ) {
    return json(buildFixedIncomeResearchStatus());
  }

  if (url.pathname === "/api/research/gdelt" && request.method === "GET") {
    if (!allow(`${actor}:gdelt-research`, 20))
      return json({ error: "GDELT research rate limit exceeded" }, 429);
    const symbol = symbolFrom(url.searchParams.get("symbol"));
    if (!validSymbol(symbol))
      return json({ error: "A valid stock symbol is required" }, 400);
    const asset = await alpaca.trading.assets.getV2AssetsSymbolOrAssetId({
      symbolOrAssetId: symbol,
    });
    const result = await (
      context.gdeltCompanySignals ?? getGdeltCompanySignals
    )(symbol, asset.name ?? symbol);
    return json({ ...result, quality: buildGdeltResearchCoverage(result) });
  }

  if (url.pathname === "/api/research/finnhub" && request.method === "GET") {
    if (!allow(`${actor}:finnhub-research`, 30))
      return json({ error: "Finnhub research rate limit exceeded" }, 429);
    const symbol = symbolFrom(url.searchParams.get("symbol"));
    if (!validSymbol(symbol))
      return json({ error: "A valid stock symbol is required" }, 400);
    const result = await (
      context.finnhubCompanyEnrichment ?? getFinnhubCompanyEnrichment
    )(symbol);
    return json({ ...result, quality: buildFinnhubResearchCoverage(result) });
  }

  if (url.pathname === "/api/research/openfigi" && request.method === "GET") {
    if (!allow(`${actor}:openfigi-research`, 30))
      return json({ error: "OpenFIGI research rate limit exceeded" }, 429);
    const symbol = symbolFrom(url.searchParams.get("symbol"));
    if (!validSymbol(symbol))
      return json({ error: "A valid stock symbol is required" }, 400);
    const asset = await alpaca.trading.assets.getV2AssetsSymbolOrAssetId({
      symbolOrAssetId: symbol,
    });
    const result = await (context.openFigiIdentity ?? getOpenFigiIdentity)(
      symbol,
      asset.name ?? symbol,
    );
    return json({ ...result, quality: buildOpenFigiResearchCoverage(result) });
  }

  if (
    url.pathname === "/api/research/comparables" &&
    request.method === "GET"
  ) {
    if (!allow(`${actor}:comparable-research`, 12)) {
      return json({ error: "Comparable valuation rate limit exceeded" }, 429);
    }
    const symbol = String(url.searchParams.get("symbol") ?? "");
    const peers = String(url.searchParams.get("peers") ?? "");
    try {
      return json(
        await (
          context.comparableValuations ??
          ((subject, peerSet) =>
            getComparableValuations(alpaca, subject, peerSet))
        )(symbol, peers),
      );
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Invalid comparable valuation request",
        },
        400,
      );
    }
  }

  if (
    url.pathname === "/api/research/valuation-runs" &&
    request.method === "POST"
  ) {
    if (!allow(`${actor}:historical-valuation`, 6))
      return json({ error: "Historical valuation rate limit exceeded" }, 429);
    const input = await requestJson(request);
    let parsed: ReturnType<typeof parseComparableSymbols>;
    let asOf: string;
    try {
      parsed = parseComparableSymbols(
        String(input.symbol ?? ""),
        Array.isArray(input.peers) ? input.peers.map(String) : String(input.peers ?? ""),
      );
      asOf = normalizeSecPointInTimeDate(String(input.asOf ?? ""));
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Invalid historical valuation request" },
        400,
      );
    }
    const runId = crypto.randomUUID();
    const model = "deterministic-comparable-valuations-v3";
    store.startResearch(runId, parsed.subject, model);
    try {
      const report = await (
        context.pointInTimeComparableValuations ??
        ((symbol, peers, cutoff) =>
          getPointInTimeComparableValuations(alpaca, symbol, peers, cutoff))
      )(parsed.subject, parsed.peers, asOf);
      if (
        report.priceMode !== "historical_daily_close" ||
        report.pointInTime.status !== "applied" ||
        report.pointInTime.asOfDate !== asOf
      )
        throw new Error("Historical valuation did not preserve the requested cutoff");
      const evidenceReplay = buildComparableValuationReplay(report);
      replayComparableValuation(evidenceReplay);
      const payload = {
        schemaVersion: "historical-comparable-valuation-run-v1" as const,
        runId,
        model,
        report,
        evidenceReplay,
      };
      store.completeResearchArtifact(runId, payload);
      store.event("research.historical_valuation.completed", actor, {
        runId,
        subject: parsed.subject,
        peers: parsed.peers,
        asOf,
        replayHash: payload.evidenceReplay.contentHash,
      });
      return json(payload, 201);
    } catch (error) {
      store.failResearch(
        runId,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  if (
    url.pathname.startsWith("/api/research/valuation-runs/") &&
    url.pathname.endsWith("/scenarios") &&
    request.method === "POST"
  ) {
    if (!allow(`${actor}:historical-scenario`, 12))
      return json({ error: "Historical scenario rate limit exceeded" }, 429);
    const parentRunId = url.pathname.split("/").at(-2) ?? "";
    const parentRun = store.getResearch(parentRunId);
    if (
      !parentRun ||
      parentRun.model !== "deterministic-comparable-valuations-v3"
    )
      return json({ error: "Historical valuation run not found" }, 404);
    const parsed = ValuationScenarioInput.safeParse(
      (await requestJson(request)).scenarios,
    );
    if (!parsed.success)
      return json(
        {
          error:
            parsed.error.issues[0]?.message ??
            "Scenario assumptions are invalid",
        },
        400,
      );
    let evidenceReplay: ReturnType<typeof buildValuationScenarioReplay>;
    try {
      evidenceReplay = buildValuationScenarioReplay(
        parentRun.payload?.evidenceReplay,
        parsed.data,
      );
      replayValuationScenario(evidenceReplay);
    } catch {
      throw new ClientError(
        "Stored historical valuation cannot support scenario replay",
        409,
      );
    }
    const runId = crypto.randomUUID();
    const model = "deterministic-valuation-scenarios-v3";
    const payload = {
      schemaVersion: "historical-valuation-scenario-run-v1" as const,
      runId,
      parentRunId,
      model,
      memo: evidenceReplay.memo,
      evidenceReplay,
    };
    store.startResearch(runId, evidenceReplay.memo.symbol, model);
    store.completeResearchArtifact(runId, payload);
    store.event("research.historical_scenario.completed", actor, {
      runId,
      parentRunId,
      symbol: evidenceReplay.memo.symbol,
      replayHash: evidenceReplay.contentHash,
    });
    return json(payload, 201);
  }

  if (
    url.pathname.startsWith("/api/research/valuation-runs/") &&
    url.pathname.endsWith("/replay") &&
    request.method === "POST"
  ) {
    const parts = url.pathname.split("/");
    const runId = parts.at(-2) ?? "";
    const stored = store.getResearch(runId);
    if (!stored || stored.model !== "deterministic-comparable-valuations-v3")
      return json({ error: "Historical valuation run not found" }, 404);
    try {
      return json(replayComparableValuation(stored.payload?.evidenceReplay));
    } catch {
      throw new ClientError(
        "Stored valuation replay failed integrity verification",
        409,
      );
    }
  }

  if (
    url.pathname.startsWith("/api/research/scenario-runs/") &&
    url.pathname.endsWith("/replay") &&
    request.method === "POST"
  ) {
    const runId = url.pathname.split("/").at(-2) ?? "";
    const stored = store.getResearch(runId);
    if (!stored || stored.model !== "deterministic-valuation-scenarios-v3")
      return json({ error: "Historical scenario run not found" }, 404);
    try {
      return json(replayValuationScenario(stored.payload?.evidenceReplay));
    } catch {
      throw new ClientError(
        "Stored scenario replay failed integrity verification",
        409,
      );
    }
  }

  if (url.pathname === "/api/research/scenarios" && request.method === "POST") {
    if (!allow(`${actor}:scenario-research`, 12)) {
      return json({ error: "Scenario valuation rate limit exceeded" }, 429);
    }
    const input = await requestJson(request);
    try {
      return json(
        await (
          context.valuationScenarios ??
          ((symbol, scenarios) =>
            getValuationScenarios(alpaca, symbol, scenarios))
        )(String(input.symbol ?? ""), input.scenarios),
      );
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Invalid scenario valuation request",
        },
        400,
      );
    }
  }

  if (url.pathname === "/api/research/runs" && request.method === "POST") {
    if (!allow(`${actor}:research`, 6))
      return json({ error: "Research agent rate limit exceeded" }, 429);
    if (!env.OPENAI_API_KEY) {
      return json(
        { error: "Add OPENAI_API_KEY to .env to enable company research" },
        503,
      );
    }
    const symbol = symbolFrom((await requestJson(request)).symbol);
    if (!validSymbol(symbol))
      return json({ error: "A valid stock symbol is required" }, 400);
    const runId = crypto.randomUUID();
    const model = openaiModel(env);
    store.startResearch(runId, symbol, model);
    try {
      const result = await (
        context.companyResearch ??
        ((requestedSymbol, requestedRunId) =>
          runCompanyResearch(alpaca, requestedSymbol, requestedRunId))
      )(symbol, runId);
      store.completeResearch(runId, result, result.metrics);
      store.event("research.completed", actor, {
        runId,
        symbol,
        score: result.metrics.overallScore,
        latencyMs: result.metrics.latencyMs,
      });
      return json(result);
    } catch (error) {
      store.failResearch(
        runId,
        error instanceof Error ? error.message : String(error),
      );
      if (
        error instanceof Error &&
        error.message.startsWith("Output guardrail triggered")
      ) {
        throw new ClientError(
          "The research report did not meet the minimum evidence-grounding threshold. Please run it again.",
          422,
        );
      }
      throw error;
    }
  }

  if (url.pathname === "/api/research/metrics" && request.method === "GET") {
    return json(store.researchMetrics());
  }

  const companyReplayMatch = url.pathname.match(
    /^\/api\/research\/runs\/([^/]+)\/replay$/,
  );
  if (companyReplayMatch && request.method === "POST") {
    const stored = store.getResearch(companyReplayMatch[1] ?? "");
    if (!stored) return json({ error: "Research run not found" }, 404);
    try {
      return json(replayCompanyResearch(stored.payload?.evidenceReplay));
    } catch {
      throw new ClientError(
        "Stored company research replay failed integrity verification",
        409,
      );
    }
  }

  if (
    url.pathname.startsWith("/api/research/runs/") &&
    request.method === "GET"
  ) {
    const research = store.getResearch(url.pathname.split("/").pop() ?? "");
    return research
      ? json(research)
      : json({ error: "Research run not found" }, 404);
  }

  return null;
}
