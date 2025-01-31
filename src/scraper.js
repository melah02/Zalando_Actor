import { Actor, RequestQueue, log, Dataset } from "apify";
import { PuppeteerCrawler, utils } from "crawlee";

await Actor.init();

let maxNumberOfPages;
const input = await Actor.getInput();
const startURLs = input?.startUrls || [
  "https://www.zalando.co.uk/mens-clothing-coats-wool-coats/",
];
const paginationLimit = input?.paginationLimit || maxNumberOfPages;
const { minPrice, maxprice } = input?.priceRange || {
  minPrice: 0,
  maxprice: 40000,
};
const { maxRequests, maxConcurrency, headless } = input?.runOption || {
  maxRequests: 999999,
  maxConcurrency: 4,
  headless: false,
};

const requestQueue = await RequestQueue.open();

for (const Url of startURLs) {
  await requestQueue.addRequest({
    url: Url,
    userData: {
      label: "PAGE",
      currrentPage: 1,
    },
  });
}

log.info("start URLs added to the queue..");

const crawler = new PuppeteerCrawler({
  headless,
  requestQueue,
  maxRequestRetries: 2,
  maxConcurrency,
  maxRequestsPerCrawl: maxRequests,
  requestHandlerTimeoutSecs: 300,
  preNavigationHooks: [
    async (crawlingContext, gotoOptions) => {
      const { page, request } = crawlingContext;
      await utils.puppeteer.blockRequests(page, {
        extraUrlPatterns: ["adsbygoogle.js"],
      });
    },
  ],
  requestHandler: async ({ page, request }) => {
    log.info(`Processing ${request.url}`);
    if (request.userData.label === "PAGE" && !request.url.endsWith(".html")) {
      log.info(`Waiting for ${request.url}    :` );
      await page.waitForSelector('a[title="previous page"]', {
        timeout: 20000,
      });
      const maxPages = await page.evaluate(() => {
        return Number(
          document
            .querySelector('a[title="previous page"]')
            .nextElementSibling?.textContent?.split("of")[1]
            ?.trim()
        );
      });

      log.info(
        maxPages > 1
          ? `${maxPages} Pages Available`
          : `${maxPages} Page Available`
      );

      maxNumberOfPages = maxPages;
      let reqCurrentPage = request.userData.currrentPage;
      while (reqCurrentPage <= maxPages) {
        const productLinks = await page.evaluate(() => {
          document
            .querySelectorAll('[id="view-tracker-wrapper"]')
            .forEach((entry) => {
              entry?.parentElement?.parentElement?.remove();
            });

          return Array.from(
            document.querySelectorAll('article [data-card-type="media"]')
          )
            .filter((link) => {
              return link.href.endsWith(".html");
            })
            .map((item) => item.href);
        });

        for (const url of productLinks) {
          log.info(`Enqueuing ${url}`);
          await requestQueue.addRequest({
            url,
            userData: { label: "DETAILS" },
          });
        }
        console.log(reqCurrentPage)
        await requestQueue.addRequest(
            {
                url: request.url + `?p=${reqCurrentPage++}`,
                userData: { label: "PAGE" },
            },
        );
        
      }
    } else if (
      request.userData.label === "DETAILS" &&
      request.url.endsWith(".html")
    ) {
        const dataScriptText = await page.evaluate(() => {
            return Array.from(
              document.querySelectorAll(`script[type="application/ld+json"]`)
            ).filter((script) =>
              script?.textContent?.includes(`"@type":"Product",`)
            )[0]?.textContent;
          });
    
          const json = JSON.parse(dataScriptText);
    
          const productName = json.name;
          const brandName = json.brand.name;
          const itemCondition = json.itemCondition?.split("/")[3];
          const sku = json.sku;
          const description = json.description;
          const color = json.color;
          const offers = json.offers;
          const price = json?.offers?.price;
    
          const productDetail = {
            productName,
            brandName,
            price,
            itemCondition,
            sku,
            description,
            color,
            offers,
          };

          await Dataset.pushData({
            productDetail
          })

    }
  },
  failedRequestHandler: async ({ request }) => {
    log.error(
      `Request ${request.url} failed after ${request.retryCount} retries.`
    );
  },
});
await crawler.run();
await Actor.exit();