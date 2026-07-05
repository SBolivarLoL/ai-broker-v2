import { TimeFrame, type Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { ClientError } from "../../http/http";
import { getSecCompanyClassification } from "../research/research";
import {
  buildPortfolioExposureReport,
  type ExposureBar,
} from "./portfolio-exposure";

export type CurrentPortfolioExposure = {
  equity: number;
  report: ReturnType<typeof buildPortfolioExposureReport>;
};

/** Fetches and briefly caches the external evidence used by exposure reports. */
export function createPortfolioExposureService(alpaca: Alpaca) {
  let cache: {
    key: string;
    expiresAt: number;
    value: CurrentPortfolioExposure;
  } | null = null;

  return async function currentPortfolioExposure(): Promise<CurrentPortfolioExposure> {
    const [account, allPositions] = await Promise.all([
      alpaca.trading.account.getAccount(),
      alpaca.trading.positions.getAllOpenPositions(),
    ]);
    if (account.equity === undefined || account.cash === undefined) {
      throw new ClientError("Account exposure data unavailable", 502);
    }

    const positions = allPositions.slice(0, 100);
    const key = JSON.stringify([
      account.equity,
      account.cash,
      positions.map((position) => [
        position.symbol,
        position.assetClass,
        position.marketValue,
      ]),
    ]);
    if (cache?.key === key && cache.expiresAt > Date.now()) return cache.value;

    const start = new Date(Date.now() - 150 * 86_400_000);
    const warnings: string[] = [];
    const [benchmarkResult] = await Promise.allSettled([
      alpaca.marketData.getStockBarsFor("SPY", {
        timeframe: TimeFrame.Day,
        start,
        feed: "iex",
      }),
    ]);
    const benchmarkBars: ExposureBar[] =
      benchmarkResult?.status === "fulfilled"
        ? benchmarkResult.value.map((bar) => ({
            date: new Date(bar.timestamp).toISOString().slice(0, 10),
            close: Number(bar.close),
          }))
        : [];
    if (!benchmarkBars.length) {
      warnings.push(
        "SPY IEX history is unavailable; market-beta exposure remains unavailable.",
      );
    }
    if (allPositions.length > positions.length) {
      warnings.push(
        `${allPositions.length - positions.length} positions were omitted by the 100-position exposure bound.`,
      );
    }

    const exposurePositions = await Promise.all(
      positions.map(async (position) => {
        const assetClass = String(position.assetClass ?? "unknown");
        const positionWarnings: string[] = [];
        if (assetClass !== "us_equity") {
          return {
            symbol: position.symbol,
            marketValue: Number(position.marketValue),
            assetClass,
            warnings: positionWarnings,
          };
        }
        const [barsResult, classificationResult] = await Promise.allSettled([
          alpaca.marketData.getStockBarsFor(position.symbol, {
            timeframe: TimeFrame.Day,
            start,
            feed: "iex",
          }),
          getSecCompanyClassification(position.symbol),
        ]);
        const bars =
          barsResult.status === "fulfilled"
            ? barsResult.value.map((bar) => ({
                date: new Date(bar.timestamp).toISOString().slice(0, 10),
                close: Number(bar.close),
              }))
            : [];
        if (!bars.length) {
          positionWarnings.push(
            `${position.symbol} IEX history is unavailable; its return-derived factor contribution is omitted.`,
          );
        }
        const official =
          classificationResult.status === "fulfilled"
            ? classificationResult.value
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
          classification,
          marketDataSource: bars.length ? "alpaca:iex" : null,
          warnings: positionWarnings,
        };
      }),
    );

    const equity = Number(account.equity);
    const report = buildPortfolioExposureReport({
      equity,
      cash: Number(account.cash),
      positions: exposurePositions,
      benchmarkBars,
      warnings,
    });
    const value = { equity, report };
    cache = { key, expiresAt: Date.now() + 5 * 60_000, value };
    return value;
  };
}
