import { TimeFrame, type Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { ClientError } from "../../http/http";
import { getSecCompanyClassification } from "../research/research";
import {
  buildPortfolioExposureReport,
  type ExposureBar,
  type ExposurePosition,
} from "./portfolio-exposure";
import {
  portfolioExposureDto,
  type ExposurePositionEvidence,
} from "./exposure-response";

export type CurrentPortfolioExposure = {
  equity: number;
  report: ReturnType<typeof portfolioExposureDto>;
};

type CachedPosition = ExposurePosition & ExposurePositionEvidence;

function normalizedBars(
  values: { timestamp: string | number | Date; close: unknown }[],
): { bars: ExposureBar[]; rejected: number } {
  const bars = values.flatMap((bar) => {
    const observedAt = new Date(bar.timestamp);
    const close = Number(bar.close);
    return Number.isFinite(observedAt.getTime()) &&
      Number.isFinite(close) &&
      close > 0
      ? [
          {
            date: observedAt.toISOString().slice(0, 10),
            close,
            observedAt: observedAt.toISOString(),
          },
        ]
      : [];
  });
  return { bars, rejected: values.length - bars.length };
}

/** Fetches and briefly caches the external evidence used by exposure reports. */
export function createPortfolioExposureService(
  alpaca: Alpaca,
  options: {
    now?: () => Date;
    getClassification?: typeof getSecCompanyClassification;
  } = {},
) {
  const now = options.now ?? (() => new Date());
  const getClassification =
    options.getClassification ?? getSecCompanyClassification;
  let cache: {
    key: string;
    expiresAt: number;
    positions: CachedPosition[];
    benchmarkBars: ExposureBar[];
    benchmarkQueried: boolean;
    benchmarkRejectedBars: number;
    benchmarkRetrievedAt: Date | null;
    warnings: string[];
  } | null = null;

  return async function currentPortfolioExposure(): Promise<CurrentPortfolioExposure> {
    const requestedAt = now();
    const [account, allPositions] = await Promise.all([
      alpaca.trading.account.getAccount(),
      alpaca.trading.positions.getAllOpenPositions(),
    ]);
    const accountRetrievedAt = now();
    if (account.equity === undefined || account.cash === undefined) {
      throw new ClientError("Account exposure data unavailable", 502);
    }

    const positions = allPositions.slice(0, 100);
    const key = JSON.stringify([
      account.equity,
      account.cash,
      allPositions.length,
      positions.map((position) => [
        position.symbol,
        position.assetClass,
        position.marketValue,
      ]),
    ]);
    let cacheHit = Boolean(
      cache?.key === key && cache.expiresAt > requestedAt.getTime(),
    );
    if (!cacheHit) {
      const start = new Date(requestedAt.getTime() - 150 * 86_400_000);
      const benchmarkQueried = positions.some(
        (position) => String(position.assetClass ?? "unknown") === "us_equity",
      );
      const [benchmarkResults, rawPositions] = await Promise.all([
        benchmarkQueried
          ? Promise.allSettled([
              alpaca.marketData.getStockBarsFor("SPY", {
                timeframe: TimeFrame.Day,
                start,
                end: requestedAt,
                feed: "iex",
              }),
            ])
          : Promise.resolve([]),
        Promise.all(
          positions.map(async (position) => {
            const assetClass = String(position.assetClass ?? "unknown");
            if (assetClass !== "us_equity") {
              return {
                position,
                assetClass,
                barsResult: null,
                classificationResult: null,
              };
            }
            const [barsResult, classificationResult] =
              await Promise.allSettled([
                alpaca.marketData.getStockBarsFor(position.symbol, {
                  timeframe: TimeFrame.Day,
                  start,
                  end: requestedAt,
                  feed: "iex",
                }),
                getClassification(position.symbol),
              ]);
            return {
              position,
              assetClass,
              barsResult,
              classificationResult,
            };
          }),
        ),
      ]);
      const externalRetrievedAt = now();
      const warnings: string[] = [];
      const benchmarkResult = benchmarkResults[0];
      const normalizedBenchmark = benchmarkResult?.status === "fulfilled"
        ? normalizedBars(benchmarkResult.value)
        : { bars: [], rejected: 0 };
      const benchmarkBars = normalizedBenchmark.bars;
      if (benchmarkQueried && !benchmarkBars.length) {
        warnings.push(
          "SPY IEX history is unavailable; market-beta exposure remains unavailable.",
        );
      }
      if (normalizedBenchmark.rejected > 0) {
        warnings.push(
          `${normalizedBenchmark.rejected} malformed SPY IEX bar${normalizedBenchmark.rejected === 1 ? " was" : "s were"} omitted.`,
        );
      }
      if (allPositions.length > positions.length) {
        warnings.push(
          `${allPositions.length - positions.length} positions were omitted by the 100-position exposure bound.`,
        );
      }

      const exposurePositions = rawPositions.map((item): CachedPosition => {
        const { position, assetClass } = item;
        const positionWarnings: string[] = [];
        if (
          assetClass !== "us_equity" ||
          item.barsResult === null ||
          item.classificationResult === null
        ) {
          return {
            symbol: position.symbol,
            marketValue: Number(position.marketValue),
            assetClass,
            bars: [],
            rejectedMarketBars: 0,
            classification: null,
            marketDataSource: null,
            warnings: positionWarnings,
            marketDataQueried: false,
            marketDataRetrievedAt: null,
            classificationQueried: false,
            classificationAvailable: false,
            classificationRetrievedAt: null,
            classificationSourceUrl: null,
          };
        }
        const normalizedPositionBars =
          item.barsResult.status === "fulfilled"
            ? normalizedBars(item.barsResult.value)
            : { bars: [], rejected: 0 };
        const bars = normalizedPositionBars.bars;
        if (!bars.length) {
          positionWarnings.push(
            `${position.symbol} IEX history is unavailable; its return-derived factor contribution is omitted.`,
          );
        }
        if (normalizedPositionBars.rejected > 0) {
          positionWarnings.push(
            `${normalizedPositionBars.rejected} malformed ${position.symbol} IEX bar${normalizedPositionBars.rejected === 1 ? " was" : "s were"} omitted.`,
          );
        }
        const official =
          item.classificationResult.status === "fulfilled"
            ? item.classificationResult.value
            : null;
        const classification = official?.sic
          ? {
              sic: official.sic,
              industry: official.industry,
              sourceUrl: official.sourceUrl,
            }
          : null;
        if (!classification) {
          positionWarnings.push(
            `${position.symbol} has no usable SEC SIC classification.`,
          );
        }
        return {
          symbol: position.symbol,
          marketValue: Number(position.marketValue),
          assetClass,
          bars,
          rejectedMarketBars: normalizedPositionBars.rejected,
          classification,
          marketDataSource: bars.length ? "alpaca:iex" : null,
          warnings: positionWarnings,
          marketDataQueried: true,
          marketDataRetrievedAt:
            item.barsResult.status === "fulfilled"
              ? externalRetrievedAt
              : null,
          classificationQueried: true,
          classificationAvailable: Boolean(classification),
          classificationRetrievedAt: official?.retrievedAt ?? null,
          classificationSourceUrl: official?.sourceUrl ?? null,
        };
      });
      cache = {
        key,
        expiresAt: externalRetrievedAt.getTime() + 5 * 60_000,
        positions: exposurePositions,
        benchmarkBars,
        benchmarkQueried,
        benchmarkRejectedBars: normalizedBenchmark.rejected,
        benchmarkRetrievedAt:
          benchmarkResult?.status === "fulfilled"
            ? externalRetrievedAt
            : null,
        warnings,
      };
      cacheHit = false;
    }

    const equity = Number(account.equity);
    const serverRespondedAt = now();
    const calculation = buildPortfolioExposureReport({
      equity,
      cash: Number(account.cash),
      positions: cache!.positions,
      benchmarkBars: cache!.benchmarkBars,
      asOf: serverRespondedAt.toISOString(),
      warnings: cache!.warnings,
    });
    return {
      equity,
      report: portfolioExposureDto({
        report: calculation,
        positionEvidence: cache!.positions,
        accountRetrievedAt,
        benchmarkBars: cache!.benchmarkBars,
        benchmarkQueried: cache!.benchmarkQueried,
        benchmarkRejectedBars: cache!.benchmarkRejectedBars,
        benchmarkRetrievedAt: cache!.benchmarkRetrievedAt,
        omittedPositionCount: allPositions.length - positions.length,
        cacheHit,
        cacheExpiresAt: cache!.expiresAt,
        serverRespondedAt,
      }),
    };
  };
}
