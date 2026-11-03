/**
 * On-demand failure injection. Every client-facing route is tagged with a FaultRoute;
 * hooks in app.ts consult this controller before, during and after the handler runs.
 *
 *  - network profile  : always applied (latency + throttled request bodies), simulates 2G
 *  - rules            : first matching rule fires, optionally limited to N times / probability
 */

export const FAULT_ROUTES = ['create', 'chunk', 'commit', 'list', 'image', 'any'] as const;
export type FaultRoute = (typeof FAULT_ROUTES)[number];

export type FaultAction =
  /** Respond immediately with this status. Handler does not run. */
  | { type: 'error'; status: number }
  /** Accept the connection and never answer. Handler does not run. */
  | { type: 'hang' }
  /** Kill the socket before reading the body. Handler does not run. */
  | { type: 'drop' }
  /** Kill the socket after this many body bytes arrived. Handler does not run. */
  | { type: 'drop-mid-body'; afterBytes: number }
  /** Run the handler (state changes!), then kill the socket instead of answering. */
  | { type: 'lose-response' }
  /** Extra delay before the handler. */
  | { type: 'delay'; ms: number };

export interface FaultRule {
  route: FaultRoute;
  action: FaultAction;
  /** Fire this many times then retire. Omit for "forever". */
  times?: number;
  /** 0..1 chance of firing per matching request. Omit for always. */
  probability?: number;
}

export interface NetworkProfile {
  latencyMs: number;
  /** Request bodies are read at this rate. null = unthrottled. */
  uploadBytesPerSec: number | null;
}

export interface FaultConfig {
  network: NetworkProfile;
  rules: FaultRule[];
}

const NO_FAULTS: FaultConfig = { network: { latencyMs: 0, uploadBytesPerSec: null }, rules: [] };
const TWO_G: NetworkProfile = { latencyMs: 700, uploadBytesPerSec: 6_000 };

/**
 * A preset without `network` keeps the current network profile, so one-shot faults stack on
 * top of `2g` (e.g. `2g` then `drop-twice` = slow link that also drops twice).
 */
export const PRESETS: Record<string, { description: string; config: { network?: NetworkProfile; rules: FaultRule[] } }> = {
  clear: { description: 'No latency, no failures', config: NO_FAULTS },
  '2g': { description: '700ms latency, ~48 kbps uploads', config: { network: TWO_G, rules: [] } },
  flaky: {
    description: '2G, and 30% of chunk uploads die mid-body',
    config: {
      network: TWO_G,
      rules: [{ route: 'chunk', action: { type: 'drop-mid-body', afterBytes: 8_000 }, probability: 0.3 }],
    },
  },
  'drop-twice': {
    description: 'Next two chunk uploads die mid-body',
    config: { rules: [{ route: 'chunk', action: { type: 'drop-mid-body', afterBytes: 8_000 }, times: 2 }] },
  },
  'lose-chunk-response': {
    description: 'Next two chunks are stored but the response is lost',
    config: { rules: [{ route: 'chunk', action: { type: 'lose-response' }, times: 2 }] },
  },
  'lose-commit-response': {
    description: 'Next report commit is stored but the response is lost',
    config: { rules: [{ route: 'commit', action: { type: 'lose-response' }, times: 1 }] },
  },
  hang: {
    description: 'Next chunk upload never gets an answer',
    config: { rules: [{ route: 'chunk', action: { type: 'hang' }, times: 1 }] },
  },
  '503': {
    description: 'Next three requests fail with 503 (retryable)',
    config: { rules: [{ route: 'any', action: { type: 'error', status: 503 }, times: 3 }] },
  },
  down: {
    description: 'Every request fails with 503 until cleared',
    config: { rules: [{ route: 'any', action: { type: 'error', status: 503 } }] },
  },
  refuse: {
    description: 'Every new upload is refused with 422 (not retryable)',
    config: { rules: [{ route: 'create', action: { type: 'error', status: 422 } }] },
  },
};

export class FaultController {
  private config: FaultConfig = structuredClone(NO_FAULTS);

  get(): FaultConfig {
    return structuredClone(this.config);
  }

  set(config: FaultConfig): void {
    this.config = structuredClone(config);
  }

  clear(): void {
    this.config = structuredClone(NO_FAULTS);
  }

  /** Picks the first rule matching `route`, consuming one of its `times`. */
  take(route: FaultRoute): FaultAction | null {
    const index = this.config.rules.findIndex(
      rule => (rule.route === route || rule.route === 'any') && (rule.probability ?? 1) > Math.random(),
    );
    if (index === -1) return null;
    const rule = this.config.rules[index]!;
    if (rule.times !== undefined) {
      rule.times -= 1;
      if (rule.times <= 0) this.config.rules.splice(index, 1);
    }
    return rule.action;
  }
}

export const faultConfigSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    network: {
      type: 'object',
      additionalProperties: false,
      required: ['latencyMs', 'uploadBytesPerSec'],
      properties: {
        latencyMs: { type: 'integer', minimum: 0 },
        uploadBytesPerSec: { type: ['integer', 'null'], minimum: 100 },
      },
    },
    rules: {
      type: 'array',
      items: {
        type: 'object',
        required: ['route', 'action'],
        properties: {
          route: { enum: FAULT_ROUTES },
          times: { type: 'integer', minimum: 1 },
          probability: { type: 'number', minimum: 0, maximum: 1 },
          action: {
            type: 'object',
            required: ['type'],
            properties: {
              type: { enum: ['error', 'hang', 'drop', 'drop-mid-body', 'lose-response', 'delay'] },
              status: { type: 'integer', minimum: 400, maximum: 599 },
              afterBytes: { type: 'integer', minimum: 0 },
              ms: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    },
  },
} as const;
