import { handleStrategyExecutionRequest } from "./strategy-execution-routes";
import { handleStrategyDatasetRequest } from "./strategy-dataset-routes";
import { handleStrategyLifecycleRequest } from "./strategy-lifecycle-routes";
import { handleStrategyReportingRequest } from "./strategy-reporting-routes";
import type { StrategyRouteContext } from "./strategy-route-context";

export type { StrategyRouteContext } from "./strategy-route-context";

/** Translates strategy HTTP requests into runtime operations. */
export async function handleStrategyRequest(
  request: Request,
  url: URL,
  context: StrategyRouteContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/strategy/")) return null;
  const executionResponse = await handleStrategyExecutionRequest(
    request,
    url,
    context,
  );
  if (executionResponse) return executionResponse;
  const datasetResponse = await handleStrategyDatasetRequest(
    request,
    url,
    context,
  );
  if (datasetResponse) return datasetResponse;
  const lifecycleResponse = await handleStrategyLifecycleRequest(
    request,
    url,
    context,
  );
  if (lifecycleResponse) return lifecycleResponse;
  const reportingResponse = await handleStrategyReportingRequest(
    request,
    url,
    context,
  );
  if (reportingResponse) return reportingResponse;

  return null;
}
