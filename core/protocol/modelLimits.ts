/** Messages about what a model's own server reports for it. */
export type ModelLimitsProtocol = {
  /**
   * What the server lists for a configured model: its window and output cap,
   * when its `/models` entry says (core/util/listedModelLimits.ts).
   */
  "models/listedLimits": [
    { title: string },
    (
      | {
          ok: true;
          limits?: import("../util/listedModelLimits").ListedLimits & {
            note?: string;
          };
        }
      | { ok: false; error: string }
    ),
  ];
};
