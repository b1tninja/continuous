import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import {
  CheckIcon,
  ChevronDownIcon,
  ClipboardIcon,
} from "@heroicons/react/24/outline";
import { useContext, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import useCopy from "../../hooks/useCopy";
import { isJetBrains } from "../../util";
import { announce } from "../a11y/announcer";
import { writeClipboardText } from "../../util/copyAsMarkdown";
import HeaderButtonWithToolTip from "./HeaderButtonWithToolTip";

interface CopyIconButtonProps {
  text: string | (() => string);
  /** When set, the button copies Markdown and the menu also offers this. */
  plainText?: string | (() => string);
  tabIndex?: number;
  /** Join the message toolbar's roving tabindex. */
  roving?: boolean;
  checkIconClassName?: string;
  clipboardIconClassName?: string;
  tooltipPlacement?: "top" | "bottom";
}

const ITEM_CLASS =
  "flex min-h-6 w-full cursor-pointer items-center border-none bg-transparent px-2 text-left text-xs text-foreground data-[focus]:bg-list-active data-[focus]:text-list-active-foreground";

function readText(text: string | (() => string)): string {
  return typeof text === "string" ? text : text();
}

export function CopyIconButton({
  text,
  plainText,
  tabIndex,
  roving,
  checkIconClassName = "h-4 w-4 text-green-400",
  clipboardIconClassName = "h-4 w-4 text-gray-400",
  tooltipPlacement = "bottom",
}: CopyIconButtonProps) {
  const { copyText, copied } = useCopy(text);
  const ideMessenger = useContext(IdeMessengerContext);
  const [menuCopied, setMenuCopied] = useState(false);
  const showMenu = plainText !== undefined;
  const copiedNow = showMenu ? menuCopied : copied;

  const write = async (value: string, label: "Markdown" | "plain text") => {
    const ok = await writeClipboardText(value, {
      jetBrains: isJetBrains(),
      post: (next) => ideMessenger.post("copyText", { text: next }),
    });
    if (ok) {
      setMenuCopied(true);
      announce(
        label === "Markdown" ? "Copied as Markdown" : "Copied as plain text",
      );
      setTimeout(() => setMenuCopied(false), 2000);
    } else {
      announce("Could not copy. The clipboard is blocked.");
    }
  };

  const icon = copiedNow ? (
    <CheckIcon className={checkIconClassName} />
  ) : (
    <ClipboardIcon className={clipboardIconClassName} />
  );

  if (!showMenu) {
    return (
      <HeaderButtonWithToolTip
        tooltipPlacement={tooltipPlacement}
        tabIndex={tabIndex}
        roving={roving}
        text={copied ? "Copied" : "Copy"}
        onClick={copyText}
      >
        {icon}
      </HeaderButtonWithToolTip>
    );
  }

  return (
    <>
      <HeaderButtonWithToolTip
        tooltipPlacement={tooltipPlacement}
        roving={roving}
        text={copiedNow ? "Copied" : "Copy as Markdown"}
        onClick={() => void write(readText(text), "Markdown")}
      >
        {icon}
      </HeaderButtonWithToolTip>
      <Menu as="div" className="relative flex">
        <MenuButton
          type="button"
          data-roving={roving ? "" : undefined}
          aria-label="Copy this message, menu"
          data-testid="copy-message-menu"
          className="flex min-h-6 min-w-6 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0.5 text-description-muted hover:bg-input focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-focus"
        >
          <ChevronDownIcon className="h-3 w-3" aria-hidden="true" />
        </MenuButton>
        <MenuItems
          anchor="top end"
          className="z-[200000] flex w-max min-w-44 flex-col rounded border border-solid border-border bg-vsc-input-background py-1 shadow-md outline-none"
        >
          <MenuItem>
            <button
              type="button"
              className={ITEM_CLASS}
              aria-label="Copy this message as Markdown"
              onClick={() => void write(readText(text), "Markdown")}
            >
              Copy as Markdown
            </button>
          </MenuItem>
          <MenuItem>
            <button
              type="button"
              className={ITEM_CLASS}
              aria-label="Copy this message as plain text"
              onClick={() => void write(readText(plainText), "plain text")}
            >
              Copy as plain text
            </button>
          </MenuItem>
        </MenuItems>
      </Menu>
    </>
  );
}
