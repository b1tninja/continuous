import * as fs from "node:fs";
import * as path from "node:path";

import type { RequestOptions } from "../index.js";
import { networkFetch } from "../util/networkFetch.js";

import {
  CATALOG_REQUEST_HEADERS,
  modelCatalogDir,
  readModelCatalogSettings,
  type ModelCatalogSettings,
} from "./modelCatalogStore.js";
import {
  classifyUsageType,
  perMillionTokens,
  PRICE_LIST_SCHEMA_VERSION,
  setBedrockPriceList,
  type BedrockPriceList,
  type BedrockPriceRow,
} from "./utils/bedrockPriceListPricing.js";

/**
 * Bedrock prices from the AWS Price List bulk file for one region
 * (`AmazonBedrock` offer, public, no credentials and no IAM), kept as a
 * dated file under the global folder (`model-catalog/bedrock-prices-<region>.json`)
 * and refreshed under the "Model information updates" setting:
 *
 * - `automatic`: in the background, at most once per refresh interval, for
 *   the region of the selected Bedrock model only;
 * - `manual`: on Test connection of a Bedrock model only;
 * - `off`: never requested, and a copy kept from before is not used.
 *
 * pricing.us-east-1.amazonaws.com is contacted only when a Bedrock model is
 * configured. The file is large, so it is read as a stream and only the
 * per-token rows are kept; nothing else of it is held in memory.
 */

export const PRICE_LIST_HOST = "pricing.us-east-1.amazonaws.com";

/** The offer file for `region`. */
export function bedrockPriceListUrl(region: string): string {
  return `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/${region}/index.json`;
}

/** Downloads larger than this are abandoned. */
export const MAX_PRICE_LIST_BYTES = 256 * 1024 * 1024;
/** One product or term larger than this is not a Price List entry. */
const MAX_MEMBER_CHARS = 1024 * 1024;
/** The whole download may take this long. */
export const PRICE_LIST_TIMEOUT_MS = 120_000;
/** After a failed download, a background refresh waits this long. */
export const PRICE_LIST_RETRY_AFTER_MS = 60 * 60 * 1000;
/** The kept rows may not be more than this (the cache file is small). */
const MAX_ROWS = 20_000;

const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d{1,2}$/;

export function isValidRegion(region: string | undefined): region is string {
  return typeof region === "string" && REGION.test(region);
}

// ---------------------------------------------------------------------------
// Streaming JSON: the members of chosen objects, one at a time

type Container = { kind: "object" | "array"; key?: string; expectKey: boolean };

/**
 * Reads JSON text chunk by chunk and hands over, parsed, each member value
 * of the objects at `paths` (and string members of the top-level object,
 * for `version` and `publicationDate`), without ever holding more than one
 * member's text. Everything else is skipped character by character.
 */
export class JsonMemberScanner {
  private stack: Container[] = [];
  private inString = false;
  private escaped = false;
  private keyBuf: string | undefined;
  private capture:
    | {
        depth: number;
        path: string[];
        key: string;
        parts: string[];
        size: number;
        isString: boolean;
      }
    | undefined;

  constructor(
    private readonly paths: string[][],
    private readonly onMember: (
      path: string[],
      key: string,
      value: unknown,
    ) => void,
  ) {}

  private currentPath(): string[] {
    return this.stack.slice(0, -1).map((c) => c.key ?? "");
  }

  private wanted(): { path: string[]; key: string } | undefined {
    const top = this.stack[this.stack.length - 1];
    if (!top || top.kind !== "object" || top.key === undefined)
      return undefined;
    const parent = [...this.currentPath()];
    for (const p of this.paths) {
      if (
        p.length === parent.length &&
        p.every((seg, i) => seg === parent[i])
      ) {
        return { path: parent, key: top.key };
      }
    }
    return undefined;
  }

  write(chunk: string): void {
    let start = this.capture ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
          if (this.keyBuf !== undefined) this.keyBuf += `\\${c}`;
        } else if (c === "\\") {
          this.escaped = true;
        } else if (c === '"') {
          this.inString = false;
          if (this.keyBuf !== undefined) {
            const top = this.stack[this.stack.length - 1];
            try {
              top.key = JSON.parse(`"${this.keyBuf}"`);
            } catch {
              top.key = this.keyBuf;
            }
            this.keyBuf = undefined;
          } else if (
            this.capture?.isString &&
            this.stack.length === this.capture.depth
          ) {
            this.finishCapture(chunk, start, i + 1);
            start = -1;
          }
        } else if (this.keyBuf !== undefined) {
          this.keyBuf += c;
          if (this.keyBuf.length > 4096)
            throw new Error("Price List key too long");
        }
        continue;
      }
      const top = this.stack[this.stack.length - 1];
      switch (c) {
        case '"':
          this.inString = true;
          if (top?.kind === "object" && top.expectKey && !this.capture) {
            this.keyBuf = "";
          } else if (!this.capture && this.stack.length === 1) {
            // A string member of the top-level object (version, dates)
            const w = this.wanted();
            if (w && this.paths.some((p) => p.length === 0)) {
              this.capture = {
                depth: 1,
                path: w.path,
                key: w.key,
                parts: [],
                size: 0,
                isString: true,
              };
              start = i;
            }
          } else if (!this.capture) {
            const w = this.wanted();
            if (w && this.stack.length > 1) {
              this.capture = {
                depth: this.stack.length,
                path: w.path,
                key: w.key,
                parts: [],
                size: 0,
                isString: true,
              };
              start = i;
            }
          }
          break;
        case "{":
        case "[": {
          if (!this.capture && this.stack.length > 1) {
            const w = this.wanted();
            if (w) {
              this.capture = {
                depth: this.stack.length,
                path: w.path,
                key: w.key,
                parts: [],
                size: 0,
                isString: false,
              };
              start = i;
            }
          }
          this.stack.push({
            kind: c === "{" ? "object" : "array",
            expectKey: c === "{",
          });
          break;
        }
        case "}":
        case "]":
          this.stack.pop();
          if (
            this.capture &&
            !this.capture.isString &&
            this.stack.length === this.capture.depth
          ) {
            this.finishCapture(chunk, start, i + 1);
            start = -1;
          }
          break;
        case ":":
          if (top) top.expectKey = false;
          break;
        case ",":
          if (top?.kind === "object") {
            top.expectKey = true;
            if (!this.capture) top.key = undefined;
          }
          break;
        default:
          break;
      }
      if (
        this.capture &&
        this.capture.size + (i - Math.max(start, 0)) > MAX_MEMBER_CHARS
      ) {
        throw new Error("A Price List entry is larger than the size limit");
      }
    }
    if (this.capture && start >= 0) {
      const piece = chunk.slice(start);
      this.capture.parts.push(piece);
      this.capture.size += piece.length;
      if (this.capture.size > MAX_MEMBER_CHARS) {
        throw new Error("A Price List entry is larger than the size limit");
      }
    }
  }

  private finishCapture(chunk: string, start: number, end: number): void {
    const cap = this.capture!;
    this.capture = undefined;
    const text = cap.parts.join("") + chunk.slice(Math.max(start, 0), end);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("The Price List file is not valid JSON");
    }
    this.onMember(cap.path, cap.key, value);
  }

  /** Throws when the text ended inside a value. */
  end(): void {
    if (this.stack.length > 0 || this.inString || this.capture) {
      throw new Error("The Price List file ended early");
    }
  }
}

// ---------------------------------------------------------------------------
// The offer file

interface ProductInfo {
  usagetype: string;
  model?: string;
  inferenceType?: string;
  regionCode?: string;
}

/**
 * Read an `AmazonBedrock` offer file (as text chunks) into price rows. Only
 * products with a per-token usage type and their on-demand USD price are
 * kept; `products` and `terms` may come in either order.
 */
export async function parseBedrockOffer(
  chunks: AsyncIterable<string> | Iterable<string>,
  region: string,
): Promise<Omit<BedrockPriceList, "source" | "fetchedAt">> {
  const products = new Map<string, ProductInfo>();
  const prices = new Map<
    string,
    { usd: number; unit?: string; description?: string }
  >();
  let version: string | undefined;
  let publicationDate: string | undefined;

  const scanner = new JsonMemberScanner(
    [[], ["products"], ["terms", "OnDemand"]],
    (p, key, value) => {
      if (p.length === 0) {
        if (key === "version" && typeof value === "string") version = value;
        if (key === "publicationDate" && typeof value === "string") {
          publicationDate = value;
        }
        return;
      }
      if (p[0] === "products") {
        const attrs = (value as { attributes?: Record<string, unknown> })
          ?.attributes;
        const usagetype = attrs?.usagetype;
        if (typeof usagetype !== "string") return;
        const str = (k: string) =>
          typeof attrs?.[k] === "string" ? (attrs[k] as string) : undefined;
        products.set(key, {
          usagetype,
          model: str("model") ?? str("modelName") ?? str("titanModel"),
          inferenceType: str("inferenceType") ?? str("feature"),
          regionCode: str("regionCode"),
        });
        return;
      }
      // terms.OnDemand[sku] = { "<sku>.<term>": { priceDimensions: { ... } } }
      if (!value || typeof value !== "object") return;
      for (const term of Object.values(value as Record<string, any>)) {
        const dims = term?.priceDimensions;
        if (!dims || typeof dims !== "object") continue;
        for (const d of Object.values(dims as Record<string, any>)) {
          const usd = Number(d?.pricePerUnit?.USD);
          if (!Number.isFinite(usd)) continue;
          if (d?.beginRange !== undefined && String(d.beginRange) !== "0") {
            continue;
          }
          prices.set(key, {
            usd,
            unit: typeof d?.unit === "string" ? d.unit : undefined,
            description:
              typeof d?.description === "string" ? d.description : undefined,
          });
          return;
        }
      }
    },
  );

  const decoder = new TextDecoder();
  for await (const chunk of chunks as AsyncIterable<string>) {
    scanner.write(typeof chunk === "string" ? chunk : decoder.decode(chunk));
  }
  scanner.end();

  const rows: BedrockPriceRow[] = [];
  for (const [sku, product] of products) {
    if (product.regionCode && product.regionCode !== region) continue;
    const price = prices.get(sku);
    if (!price) continue;
    const kind = classifyUsageType(product.usagetype, product.inferenceType);
    if (!kind) continue;
    const usdPerMTok = perMillionTokens(
      price.usd,
      price.unit,
      price.description,
    );
    if (usdPerMTok === undefined) continue;
    rows.push({
      model: product.model ?? kind.model,
      kind: kind.kind,
      tier: kind.tier,
      route: kind.route,
      ...(kind.mantle ? { mantle: true } : {}),
      usdPerMTok,
      usagetype: product.usagetype,
    });
    // The usage type's own model words, when the product's model name is
    // spelled differently
    if (product.model && product.model !== kind.model && kind.model) {
      rows.push({
        model: kind.model,
        kind: kind.kind,
        tier: kind.tier,
        route: kind.route,
        ...(kind.mantle ? { mantle: true } : {}),
        usdPerMTok,
        usagetype: product.usagetype,
      });
    }
    if (rows.length > MAX_ROWS) {
      throw new Error("The Price List has more rows than the limit");
    }
  }
  return {
    schemaVersion: PRICE_LIST_SCHEMA_VERSION,
    region,
    ...(version ? { version } : {}),
    ...(publicationDate ? { publicationDate } : {}),
    rows,
  };
}

// ---------------------------------------------------------------------------
// Cache

export function bedrockPriceListPath(
  region: string,
  dir = modelCatalogDir(),
): string {
  return path.join(dir, `bedrock-prices-${region}.json`);
}

function validList(
  value: unknown,
  region: string,
): BedrockPriceList | undefined {
  const v = value as BedrockPriceList | undefined;
  if (
    !v ||
    v.schemaVersion !== PRICE_LIST_SCHEMA_VERSION ||
    v.region !== region ||
    typeof v.fetchedAt !== "string" ||
    !Array.isArray(v.rows)
  ) {
    return undefined;
  }
  const rows = v.rows.filter(
    (r) =>
      r &&
      typeof r.model === "string" &&
      typeof r.usdPerMTok === "number" &&
      Number.isFinite(r.usdPerMTok),
  );
  return { ...v, rows };
}

/** The kept list for `region`, or undefined. A local read. */
export function readBedrockPriceList(
  region: string,
  dir?: string,
): BedrockPriceList | undefined {
  if (!isValidRegion(region)) return undefined;
  const file = bedrockPriceListPath(region, dir);
  try {
    if (fs.statSync(file).size > 16 * 1024 * 1024) return undefined;
    return validList(JSON.parse(fs.readFileSync(file, "utf8")), region);
  } catch {
    return undefined;
  }
}

/** Write through a temporary file, so a reader never sees half a list. */
export function writeBedrockPriceList(
  list: BedrockPriceList,
  dir?: string,
): void {
  const file = bedrockPriceListPath(list.region, dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(list), "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing to clean up
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Download

/** The body of a fetch response as text chunks, Node stream or web stream. */
async function* bodyChunks(
  body: unknown,
  maxBytes: number,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let total = 0;
  const take = (bytes: Uint8Array | string): string => {
    const piece =
      typeof bytes === "string"
        ? bytes
        : decoder.decode(bytes, { stream: true });
    total +=
      typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength;
    if (total > maxBytes) {
      throw new Error("The Price List file is larger than the size limit");
    }
    return piece;
  };
  if (body && typeof (body as any)[Symbol.asyncIterator] === "function") {
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      yield take(chunk);
    }
  } else if (body && typeof (body as any).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        yield take(value);
      }
    } finally {
      reader.releaseLock?.();
    }
  } else {
    throw new Error("The Price List answer has no body");
  }
  const rest = decoder.decode();
  if (rest) yield rest;
}

export interface PriceListFetchOptions {
  requestOptions?: RequestOptions;
  /** Tests: instead of the network */
  fetch?: (url: string, init: any) => Promise<Response>;
  dir?: string;
  now?: () => Date;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Download, stream-parse and keep the Price List for `region`. One GET to
 * pricing.us-east-1.amazonaws.com with no credentials and the same two
 * headers as the OpenRouter list. Throws with a short message; the kept
 * copy is left as it was.
 */
export async function fetchBedrockPriceList(
  region: string,
  opts: PriceListFetchOptions = {},
): Promise<BedrockPriceList> {
  if (!isValidRegion(region)) {
    throw new Error(`Not an AWS region: ${region}`);
  }
  const url = bedrockPriceListUrl(region);
  const maxBytes = opts.maxBytes ?? MAX_PRICE_LIST_BYTES;
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(),
    opts.timeoutMs ?? PRICE_LIST_TIMEOUT_MS,
  );
  (timer as { unref?: () => void }).unref?.();
  try {
    const init = {
      method: "GET",
      headers: { ...CATALOG_REQUEST_HEADERS },
      signal: abort.signal,
    };
    const response = opts.fetch
      ? await opts.fetch(url, init)
      : await networkFetch(url, init, opts.requestOptions);
    if (response.status === 404 || response.status === 403) {
      throw new Error(`The AWS Price List has no Bedrock prices for ${region}`);
    }
    if (!response.ok) {
      throw new Error(`${PRICE_LIST_HOST} answered ${response.status}`);
    }
    const length = Number(response.headers?.get?.("content-length") ?? 0);
    if (length > maxBytes) {
      throw new Error("The Price List file is larger than the size limit");
    }
    const parsed = await parseBedrockOffer(
      bodyChunks(response.body, maxBytes),
      region,
    );
    if (parsed.rows.length === 0) {
      throw new Error(`The AWS Price List has no token prices for ${region}`);
    }
    const list: BedrockPriceList = {
      ...parsed,
      source: url,
      fetchedAt: (opts.now?.() ?? new Date()).toISOString(),
    };
    writeBedrockPriceList(list, opts.dir);
    return list;
  } catch (e) {
    if (abort.signal.aborted) {
      throw new Error("The AWS Price List download took too long");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Under the setting

export type PriceListTrigger =
  "test-connection" | "model-selected" | "background";

const inFlight = new Map<string, Promise<BedrockPriceList>>();
const lastFailure = new Map<string, number>();

/** Forget failures and downloads in progress (tests). */
export function resetBedrockPriceListState(): void {
  inFlight.clear();
  lastFailure.clear();
}

function isStale(fetchedAt: string, hours: number, now: number): boolean {
  const t = Date.parse(fetchedAt);
  return !Number.isFinite(t) || t > now || now - t >= hours * 60 * 60 * 1000;
}

/**
 * Put the prices of `region` in front of the cost functions, downloading
 * them when the setting allows and the kept copy is missing or older than
 * the refresh interval:
 *
 * - `off`: nothing is requested, and the kept copy is not used either;
 * - `test-connection` downloads under `automatic` and `manual`;
 * - `model-selected` and `background` download only under `automatic`; a
 *   selection waits an hour after a failed download, the background
 *   refresher backs off by itself.
 *
 * Returns the list in use (or undefined). Throws only when a download was
 * made and failed, so a background refresher can back off; the kept copy
 * stays in use.
 */
export async function ensureBedrockPriceList(
  region: string | undefined,
  trigger: PriceListTrigger,
  opts: PriceListFetchOptions & {
    settings?: ModelCatalogSettings;
    /**
     * Put the list in front of the cost functions (default). False for a
     * Test connection of a region other than the selected model's.
     */
    activate?: boolean;
  } = {},
): Promise<BedrockPriceList | undefined> {
  const settings = opts.settings ?? readModelCatalogSettings();
  const activate = (list: BedrockPriceList | undefined) => {
    if (opts.activate !== false) setBedrockPriceList(list);
  };
  if (settings.policy === "off" || !isValidRegion(region)) {
    activate(undefined);
    return undefined;
  }
  const kept = readBedrockPriceList(region, opts.dir);
  activate(kept);
  const now = opts.now?.().getTime() ?? Date.now();
  if (kept && !isStale(kept.fetchedAt, settings.refreshHours, now)) {
    return kept;
  }
  // The background refresher has its own backoff; a selection waits an hour
  // after a failure so switching models does not download again and again
  const mayFetch =
    trigger === "test-connection" ||
    (settings.policy === "automatic" &&
      (trigger === "background" ||
        now - (lastFailure.get(region) ?? -Infinity) >=
          PRICE_LIST_RETRY_AFTER_MS));
  if (!mayFetch) return kept;
  let pending = inFlight.get(region);
  if (!pending) {
    pending = fetchBedrockPriceList(region, opts).finally(() =>
      inFlight.delete(region),
    );
    inFlight.set(region, pending);
  }
  try {
    const list = await pending;
    lastFailure.delete(region);
    activate(list);
    return list;
  } catch (e) {
    lastFailure.set(region, now);
    throw e;
  }
}
