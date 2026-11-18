import { URL } from "node:url";

import { ContinueConfig, IDE } from "../../..";
import { assertWebEnabled } from "../../../util/webConfig";

import CheerioCrawler from "./CheerioCrawler";
import { ChromiumCrawler, ChromiumInstaller } from "./ChromiumCrawler";
import GitHubCrawler from "./GitHubCrawler";

export type PageData = {
  url: string;
  path: string;
  content: string;
};

export type DocsCrawlerType = "cheerio" | "chromium" | "github";

class DocsCrawler {
  private readonly GITHUB_HOST = "github.com";
  private readonly chromiumInstaller: ChromiumInstaller;

  constructor(
    private readonly ide: IDE,
    private readonly config: ContinueConfig,
    private readonly maxDepth: number = 4,
    private readonly maxRequestsPerCrawl: number = 1000,
    private readonly githubToken: string | undefined = undefined,
  ) {
    this.chromiumInstaller = new ChromiumInstaller(this.ide, this.config);
  }

  private shouldUseChromium() {
    return (
      this.config.experimental?.useChromiumForDocsCrawling &&
      this.chromiumInstaller.isInstalled()
    );
  }

  /*
    Returns the type of crawler used in the end
  */
  async *crawl(
    startUrl: URL,
  ): AsyncGenerator<PageData, DocsCrawlerType, undefined> {
    // web.enabled: false turns the docs crawler off too (WB45)
    assertWebEnabled("docs are not crawled");
    if (startUrl.host === this.GITHUB_HOST) {
      yield* new GitHubCrawler(
        startUrl,
        this.githubToken,
        this.config.requestOptions,
      ).crawl();
      return "github";
    }

    if (this.shouldUseChromium()) {
      yield* new ChromiumCrawler(
        startUrl,
        this.maxRequestsPerCrawl,
        this.maxDepth,
        this.config.requestOptions,
      ).crawl();
      return "chromium";
    } else {
      let didCrawlSinglePage = false;

      for await (const pageData of new CheerioCrawler(
        startUrl,
        this.maxRequestsPerCrawl,
        this.maxDepth,
        this.config.requestOptions,
      ).crawl()) {
        yield pageData;
        didCrawlSinglePage = true;
      }

      // We assume that if we failed to crawl a single page,
      // it was due to an error that using Chromium can resolve
      const shouldProposeUseChromium =
        !didCrawlSinglePage &&
        this.chromiumInstaller.shouldProposeUseChromiumOnCrawlFailure();

      if (shouldProposeUseChromium) {
        const didInstall =
          await this.chromiumInstaller.proposeAndAttemptInstall(
            startUrl.toString(),
          );

        if (didInstall) {
          void this.ide.showToast(
            "info",
            `Successfully installed Chromium! Retrying crawl of: ${startUrl.toString()}`,
          );

          yield* new ChromiumCrawler(
            startUrl,
            this.maxRequestsPerCrawl,
            this.maxDepth,
            this.config.requestOptions,
          ).crawl();
          return "chromium";
        }
      }

      return "cheerio";
    }
  }
}

export default DocsCrawler;
export { CheerioCrawler, ChromiumCrawler, ChromiumInstaller, GitHubCrawler };
