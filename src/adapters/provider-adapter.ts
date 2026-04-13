import type { ProviderRequest, ProviderResponse } from "../types.js";

export interface ProviderAdapter {
  send(request: ProviderRequest): Promise<ProviderResponse>;
}
