import { PagedResult, listAllPages } from "./mcpPagination";

/**
 * Paged `tools/list`, `resources/list`, `resources/templates/list` and
 * `prompts/list` for any client with the SDK's method shapes (the SDK `Client`
 * or the stateless client). Duplicates across pages are dropped by identity
 * (first one wins), so a server cannot shadow a tool by repeating its name on
 * a later page.
 */

interface ListOpts {
  signal?: AbortSignal;
  timeout?: number;
}

export interface ListingClient {
  listTools(p?: any, o?: ListOpts): Promise<{ tools: any[]; nextCursor?: any }>;
  listResources(
    p?: any,
    o?: ListOpts,
  ): Promise<{ resources: any[]; nextCursor?: any }>;
  listResourceTemplates(
    p?: any,
    o?: ListOpts,
  ): Promise<{ resourceTemplates: any[]; nextCursor?: any }>;
  listPrompts(
    p?: any,
    o?: ListOpts,
  ): Promise<{ prompts: any[]; nextCursor?: any }>;
}

export function listToolsPaged(client: ListingClient, o?: ListOpts) {
  return listAllPages<any>(
    async (cursor) => {
      const r = await client.listTools(cursor ? { cursor } : {}, o);
      return { items: r.tools ?? [], nextCursor: r.nextCursor };
    },
    { kind: "tools", keyOf: (t) => String(t?.name), signal: o?.signal },
  );
}

export function listResourcesPaged(client: ListingClient, o?: ListOpts) {
  return listAllPages<any>(
    async (cursor) => {
      const r = await client.listResources(cursor ? { cursor } : {}, o);
      return { items: r.resources ?? [], nextCursor: r.nextCursor };
    },
    { kind: "resources", keyOf: (t) => String(t?.uri), signal: o?.signal },
  );
}

export function listResourceTemplatesPaged(
  client: ListingClient,
  o?: ListOpts,
) {
  return listAllPages<any>(
    async (cursor) => {
      const r = await client.listResourceTemplates(cursor ? { cursor } : {}, o);
      return { items: r.resourceTemplates ?? [], nextCursor: r.nextCursor };
    },
    {
      kind: "resource templates",
      keyOf: (t) => String(t?.uriTemplate),
      signal: o?.signal,
    },
  );
}

export function listPromptsPaged(client: ListingClient, o?: ListOpts) {
  return listAllPages<any>(
    async (cursor) => {
      const r = await client.listPrompts(cursor ? { cursor } : {}, o);
      return { items: r.prompts ?? [], nextCursor: r.nextCursor };
    },
    { kind: "prompts", keyOf: (t) => String(t?.name), signal: o?.signal },
  );
}

export type { PagedResult };
