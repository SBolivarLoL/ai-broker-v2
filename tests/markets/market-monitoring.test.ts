import { expect, test } from "bun:test";
import {
  monitoringCorporateActions,
  monitoringEventClusters,
  monitoringNews,
  monitoringSecFilings,
} from "../../backend/features/markets/market-monitoring";
import type { Sec8KAlertEvidence } from "../../backend/integrations/sec-edgar";

const positions = [{ symbol: "AAPL", qty: "10" }];
const watchlists = [
  { id: "growth", name: "Growth", assets: [{ symbol: "MSFT" }] },
];

test("market monitoring keeps only portfolio and watchlist news with explicit relevance", () => {
  const articles = [
    {
      id: 1,
      headline: "Apple update",
      summary: "Analyst&#39;s note",
      source: "Wire",
      symbols: ["AAPL"],
      createdAt: new Date("2026-06-22T10:00:00Z"),
      updatedAt: new Date("2026-06-22T10:00:00Z"),
      url: "https://example.com/a",
    },
    {
      id: 2,
      headline: "Microsoft update",
      summary: "B",
      source: "Wire",
      symbols: ["MSFT"],
      createdAt: new Date("2026-06-22T11:00:00Z"),
      updatedAt: new Date("2026-06-22T11:00:00Z"),
    },
    {
      id: 3,
      headline: "Unrelated",
      summary: "C",
      source: "Wire",
      symbols: ["TSLA"],
      createdAt: new Date("2026-06-22T12:00:00Z"),
      updatedAt: new Date("2026-06-22T12:00:00Z"),
    },
  ];
  const result = monitoringNews(articles, positions, watchlists);
  expect(result.map((article) => article.id)).toEqual([1, 2]);
  expect(result[0].relevance.portfolio).toBe(true);
  expect(result[0].summary).toBe("Analyst's note");
  expect(result[0].relevantSymbols).toEqual(["AAPL"]);
  expect(result[1].relevance.watchlists).toEqual([
    { id: "growth", name: "Growth" },
  ]);
});

test("market monitoring estimates bounded holding impact for dividends and splits", () => {
  const actions = monitoringCorporateActions(
    {
      cashDividends: [
        {
          id: "div",
          symbol: "AAPL",
          exDate: new Date("2026-06-25"),
          processDate: new Date("2026-06-24"),
          rate: 0.25,
        },
      ],
      forwardSplits: [
        {
          id: "split",
          symbol: "AAPL",
          exDate: new Date("2026-07-01"),
          processDate: new Date("2026-06-30"),
          oldRate: 1,
          newRate: 4,
        },
      ],
      spinOffs: [
        {
          id: "spin",
          sourceSymbol: "MSFT",
          newSymbol: "NEW",
          exDate: new Date("2026-07-02"),
          processDate: new Date("2026-07-01"),
        },
      ],
      nameChanges: [
        {
          id: "ignore",
          oldSymbol: "TSLA",
          newSymbol: "TSL",
          processDate: new Date("2026-07-03"),
        },
      ],
    },
    positions,
    watchlists,
  );
  expect(actions).toHaveLength(3);
  expect(actions.find((action) => action.id === "div")?.impact).toMatchObject({
    kind: "cash",
    estimatedCash: 2.5,
  });
  expect(actions.find((action) => action.id === "split")?.impact).toMatchObject(
    { kind: "quantity", estimatedQuantity: 40 },
  );
  expect(
    actions.find((action) => action.id === "spin")?.relevance.watchlists[0]
      ?.name,
  ).toBe("Growth");
});

test("clusters earnings, dividend and corporate-action timelines without inventing events", () => {
  const news = monitoringNews(
    [
      {
        id: 1,
        headline: "Apple reports quarterly earnings",
        summary: "Results",
        source: "Wire",
        symbols: ["AAPL"],
        createdAt: new Date("2026-06-22T10:00:00Z"),
      },
      {
        id: 2,
        headline: "Analysts discuss Apple earnings guidance",
        summary: "Quarter",
        source: "Wire",
        symbols: ["AAPL"],
        createdAt: new Date("2026-06-22T11:00:00Z"),
      },
    ],
    positions,
    watchlists,
  );
  const actions = monitoringCorporateActions(
    {
      cashDividends: [
        {
          id: "div",
          symbol: "AAPL",
          exDate: new Date("2026-06-25"),
          rate: 0.25,
        },
      ],
    },
    positions,
    watchlists,
  );
  const clusters = monitoringEventClusters(news, actions);
  expect(clusters.find((cluster) => cluster.kind === "earnings")).toMatchObject(
    { symbol: "AAPL", count: 2 },
  );
  expect(
    clusters.find((cluster) => cluster.kind === "dividend")?.timeline[0]
      ?.source,
  ).toBe("corporate_action");
});

test("scopes SEC 8-K alerts and prioritizes material filing items", () => {
  const base = {
    companyName: "Apple Inc.",
    form: "8-K",
    reportDate: "2026-06-27",
    sourceUrl: "https://www.sec.gov/a",
    indexUrl: "https://www.sec.gov/a-index",
    relevanceSummary: "Grounded filing excerpt.",
    items: [],
    retrievedAt: "2026-06-29T12:00:00.000Z",
  };
  const alerts = monitoringSecFilings(
    [
      {
        ...base,
        id: "sec:8k:AAPL:critical",
        symbol: "AAPL",
        filed: "2026-06-28",
        accession: "critical",
        importance: "critical",
        primaryItem: {
          code: "1.05",
          label: "Material Cybersecurity Incidents",
        },
      },
      {
        ...base,
        id: "sec:8k:MSFT:standard",
        symbol: "MSFT",
        filed: "2026-06-29",
        accession: "standard",
        importance: "standard",
        primaryItem: { code: "7.01", label: "Regulation FD Disclosure" },
      },
      {
        ...base,
        id: "sec:8k:TSLA:ignore",
        symbol: "TSLA",
        filed: "2026-06-29",
        accession: "ignore",
        importance: "high",
        primaryItem: { code: "1.01", label: "Material Agreement" },
      },
    ] as Sec8KAlertEvidence[],
    positions,
    watchlists,
  );
  expect(alerts.map((alert) => alert.accession)).toEqual([
    "critical",
    "standard",
  ]);
  expect(alerts[0]?.relevance.portfolio).toBe(true);
  expect(alerts[1]?.relevance.watchlists).toEqual([
    { id: "growth", name: "Growth" },
  ]);
  const clusters = monitoringEventClusters([], [], alerts);
  expect(clusters.find((cluster) => cluster.symbol === "MSFT")).toMatchObject({
    kind: "sec_8k",
    count: 1,
  });
  expect(
    clusters.find((cluster) => cluster.symbol === "AAPL")?.timeline[0]?.source,
  ).toBe("sec_8k");
});
