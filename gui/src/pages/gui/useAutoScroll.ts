import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { announce } from "../../components/a11y/announcer";
import { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionSlice";
import { prefersReducedMotion } from "../../util/reducedMotion";

/**
 * Only reset scroll state when a new user message is added to the chat.
 * We don't want to auto-scroll on new tool response messages.
 */
function getNumUserMsgs(history: ChatHistoryItemWithMessageId[]) {
  return history.filter((msg) => msg.message.role === "user").length;
}

/** Pixels from the bottom that still count as being at the bottom. */
export const AT_BOTTOM_TOLERANCE = 8;

/** Said once per pause, not per token. */
export const NEW_CONTENT_ANNOUNCEMENT = "New messages below";

export const useAutoScroll = (
  ref: React.RefObject<HTMLDivElement | null>,
  history: ChatHistoryItemWithMessageId[],
) => {
  const [userHasScrolled, setUserHasScrolled] = useState(false);
  const numUserMsgs = useMemo(() => getNumUserMsgs(history), [history.length]);
  // The height when auto-scroll paused, and whether the person was told yet
  const pausedHeight = useRef(0);
  const announced = useRef(false);

  useEffect(() => {
    if (!userHasScrolled) return;
    pausedHeight.current = ref.current?.scrollHeight ?? 0;
    announced.current = false;
  }, [userHasScrolled, ref]);

  const scrollToLatest = useCallback(() => {
    const elem = ref.current;
    if (!elem) return;
    if (typeof elem.scrollTo === "function") {
      elem.scrollTo({
        top: elem.scrollHeight,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    } else {
      elem.scrollTop = elem.scrollHeight;
    }
    setUserHasScrolled(false);
  }, [ref]);

  useEffect(() => {
    setUserHasScrolled(false);
  }, [numUserMsgs]);

  useEffect(() => {
    if (!ref.current || history.length === 0) return;

    let lastScrollTop = ref.current.scrollTop;
    const handleScroll = () => {
      const elem = ref.current;
      if (!elem) return;

      const distance = elem.scrollHeight - elem.scrollTop - elem.clientHeight;
      const movedUp = elem.scrollTop < lastScrollTop - 1;
      lastScrollTop = elem.scrollTop;

      /**
       * We resume auto scrolling when the view is at the bottom, within a few
       * pixels (a fractional scrollTop never lands exactly on it). We stop
       * only when the user moved up: a scroll event that arrives after the
       * content below grew, or the box shrank because a panel under it grew
       * (Loop's plan and inbox do that all the time), is not the user leaving.
       */
      if (distance <= AT_BOTTOM_TOLERANCE) {
        setUserHasScrolled(false);
      } else if (movedUp) {
        setUserHasScrolled(true);
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      const elem = ref.current;
      if (!elem) return;
      if (userHasScrolled) {
        if (!announced.current && elem.scrollHeight > pausedHeight.current) {
          announced.current = true;
          announce(NEW_CONTENT_ANNOUNCEMENT);
        }
        return;
      }
      elem.scrollTop = elem.scrollHeight;
    });

    ref.current.addEventListener("scroll", handleScroll);

    // Observe the container
    resizeObserver.observe(ref.current);

    // Observe all immediate children
    Array.from(ref.current.children).forEach((child) => {
      resizeObserver.observe(child);
    });

    return () => {
      resizeObserver.disconnect();
      ref.current?.removeEventListener("scroll", handleScroll);
    };
  }, [ref, history.length, userHasScrolled]);

  return { paused: userHasScrolled, scrollToLatest };
};
