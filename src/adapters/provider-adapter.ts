import type { ProviderRequest, ProviderResponse } from "../types.js";

export interface ProviderAdapter {
  cancel?(sessionId:string): boolean;
  send(request: ProviderRequest): Promise<ProviderResponse>;
}
