import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/**
 * From the model checklist to the review. With a model being added the way
 * goes through "Use for" (its Next), otherwise straight to the review.
 */
export async function toReview(user: UserEvent): Promise<void> {
  await screen.findByTestId("model-checklist");
  const next = screen.queryByRole("button", { name: "Next" });
  if (next) await user.click(next);
  await user.click(await screen.findByRole("button", { name: "Review" }));
}
