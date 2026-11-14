import fs from "fs";
import path from "path";

import {
  allDevEventNames,
  DataLogLevel,
  DevDataLogEvent,
  devDataVersionedSchemas,
} from "@continuedev/config-yaml";
import { fetchwithRequestOptions } from "@continuedev/fetch";
import * as URI from "uri-js";
import { fileURLToPath } from "url";
import { ZodObject } from "zod";
import { Core } from "../core.js";
import { ContinueConfig, IdeInfo, IdeSettings } from "../index.js";
import {
  appendDebugPrompt,
  debugPromptLogEnabled,
} from "../util/debugPromptLog.js";
import { getDevDataFilePath } from "../util/paths.js";
import { appendPrivate } from "../util/privateFiles.js";
import { scrubDeep } from "../util/secretScan/scrubForDisk.js";
import { joinPathsToUri } from "../util/uri.js";
import { summarizeChatInteraction } from "./chatInteractionSummary.js";

const DEFAULT_DEV_DATA_LEVEL: DataLogLevel = "all";
export const LOCAL_DEV_DATA_VERSION = "0.2.0";
export class DataLogger {
  private static instance: DataLogger | null = null;
  core?: Core;
  ideSettingsPromise?: Promise<IdeSettings>;
  ideInfoPromise?: Promise<IdeInfo>;

  private constructor() {}

  public static getInstance(): DataLogger {
    if (DataLogger.instance === null) {
      DataLogger.instance = new DataLogger();
    }
    return DataLogger.instance;
  }

  async addBaseValues(
    body: Record<string, any>,
    eventName: string,
    schema: string,
    zodSchema: ZodObject,
  ): Promise<Record<string, any>> {
    const newBody = { ...body };
    const ideSettings = await this.ideSettingsPromise;
    const ideInfo = await this.ideInfoPromise;

    if ("eventName" in zodSchema.shape) {
      newBody.eventName = eventName;
    }
    if (!newBody.timestamp && "timestamp" in zodSchema.shape) {
      newBody.timestamp = new Date().toISOString();
    }
    if ("schema" in zodSchema.shape) {
      newBody.schema = schema;
    }
    if ("userAgent" in zodSchema.shape) {
      newBody.userAgent = ideInfo
        ? `${ideInfo.name}/${ideInfo.version} (Continuous/${ideInfo.extensionVersion})`
        : "Unknown/Unknown (Continuous/Unknown)";
    }
    if ("selectedProfileId" in zodSchema.shape) {
      newBody.selectedProfileId =
        this.core?.configHandler.currentProfile?.profileDescription.id ?? "";
    }
    if ("userId" in zodSchema.shape) {
      newBody.userId = ideSettings?.userToken ?? "";
    }

    return newBody;
  }

  async logLocalData(event: DevDataLogEvent) {
    try {
      const filepath: string = getDevDataFilePath(
        event.name,
        LOCAL_DEV_DATA_VERSION,
      );
      const localSchema =
        devDataVersionedSchemas[LOCAL_DEV_DATA_VERSION]["all"][event.name];

      if (!localSchema) {
        throw new Error(
          `Schema ${LOCAL_DEV_DATA_VERSION} doesn't exist at level "all"`,
        );
      }

      const eventDataWithBaseValues = await this.addBaseValues(
        await this.localEventData(event),
        event.name,
        LOCAL_DEV_DATA_VERSION,
        localSchema,
      );

      const parsed = localSchema?.safeParse(eventDataWithBaseValues);
      if (parsed?.success) {
        // X15: commands, prompts and code in an event never land with a secret
        appendPrivate(filepath, `${JSON.stringify(scrubDeep(parsed.data))}\n`);
      }
    } catch (error) {
      console.error("Error logging local dev data:", error);
    }
  }

  /**
   * STOR4: the local copy of a chatInteraction keeps sizes, token counts and
   * a hash, not the prompt and completion. With the debug prompt log on, the
   * full texts go to that log (scrubbed, capped, aged out) instead.
   */
  private async localEventData(
    event: DevDataLogEvent,
  ): Promise<Record<string, any>> {
    if (event.name !== "chatInteraction") return event.data;
    const data = event.data as Record<string, any>;
    const settings = await this.ideSettingsPromise?.catch(() => undefined);
    if (
      typeof data.prompt === "string" &&
      debugPromptLogEnabled(settings?.debugPromptLog)
    ) {
      appendDebugPrompt({
        sessionId: data.sessionId,
        model: data.modelTitle ?? data.modelName,
        provider: data.modelProvider,
        prompt: data.prompt,
        completion: data.completion,
      });
    }
    return summarizeChatInteraction(data);
  }

  async logDevData(event: DevDataLogEvent) {
    // Local logs (always on for all levels)
    await this.logLocalData(event);

    // Remote logs
    const config = (await this.core?.configHandler.loadConfig())?.config;
    if (config?.data?.length) {
      await Promise.allSettled(
        config.data.map((dataConfig) =>
          this.logToOneDestination(dataConfig, event),
        ),
      );
    }
  }

  async parseEventData(
    event: DevDataLogEvent,
    schema: string,
    level: "all" | "noCode",
  ) {
    const versionSchemas = devDataVersionedSchemas[schema];
    if (!versionSchemas) {
      throw new Error(
        `Attempting to log dev data to non-existent version ${schema}`,
      );
    }

    const levelSchemas = versionSchemas[level];
    if (!levelSchemas) {
      throw new Error(
        `Attempting to log dev data at level ${level} for version ${schema} which does not exist`,
      );
    }

    const zodSchema = levelSchemas[event.name];
    if (!zodSchema) {
      throw new Error(
        `Attempting to log dev data for event ${event.name} at level ${level} for version ${schema}: no schema found`,
      );
    }

    const eventDataWithBaseValues = await this.addBaseValues(
      event.data,
      event.name,
      schema,
      zodSchema,
    );

    const parsed = zodSchema.safeParse(eventDataWithBaseValues);
    if (!parsed.success) {
      throw new Error(
        `Failed to parse event data for event ${event.name} and schema ${schema}\n:${parsed.error.toString()}`,
      );
    }

    return parsed.data;
  }

  async logToOneDestination(
    dataConfig: NonNullable<ContinueConfig["data"]>[number],
    event: DevDataLogEvent,
  ) {
    try {
      if (!dataConfig) {
        return;
      }

      // First extract the data schema based on the version and level
      const { schema } = dataConfig;
      const level = dataConfig.level ?? DEFAULT_DEV_DATA_LEVEL;

      // Skip event if `events` is specified and does not include the event
      const events = dataConfig.events ?? allDevEventNames;
      if (!events.includes(event.name)) {
        return;
      }

      // Parse the event data, throwing if it fails
      const parsed = await this.parseEventData(event, schema, level);

      const uriComponents = URI.parse(dataConfig.destination);

      // Send to remote server
      if (uriComponents.scheme === "https" || uriComponents.scheme === "http") {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        if (dataConfig.apiKey) {
          headers["Authorization"] = `Bearer ${dataConfig.apiKey}`;
        }

        const profileId =
          this.core?.configHandler.currentProfile?.profileDescription.id ?? "";
        const response = await fetchwithRequestOptions(
          dataConfig.destination,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              name: event.name,
              data: parsed,
              schema,
              level,
              profileId,
            }),
          },
          dataConfig.requestOptions,
        );
        if (!response.ok) {
          throw new Error(
            `Post request failed. ${response.status}: ${response.statusText}`,
          );
        }
      } else if (uriComponents.scheme === "file") {
        // X15 decision: a file:// destination is the user's own sink and is
        // written as configured, not scrubbed. Only the local dev_data copy is.
        // Write to jsonc file for local file URIs
        const dirUri = joinPathsToUri(dataConfig.destination, schema);
        const dirPath = fileURLToPath(dirUri);

        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
        const filepath = path.join(dirPath, `${event.name}.jsonl`);
        const jsonLine = JSON.stringify(event.data);
        fs.writeFileSync(filepath, `${jsonLine}\n`, { flag: "a" });
      } else {
        throw new Error(`Unsupported URI scheme ${uriComponents.scheme}`);
      }
    } catch (error) {
      console.error(
        `Error logging data to ${dataConfig.destination}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
