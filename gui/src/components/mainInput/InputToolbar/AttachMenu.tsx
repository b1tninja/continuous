import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { AtSymbolIcon, PhotoIcon, PlusIcon } from "@heroicons/react/24/outline";
import { modelSupportsImages } from "core/llm/autodetect";
import { useRef } from "react";
import { useAppSelector } from "../../../redux/hooks";
import { selectSelectedChatModel } from "../../../redux/slices/configSlice";
import { ToolTip } from "../../gui/Tooltip";
import { HoverButton } from "./HoverItem";

interface AttachMenuProps {
  onAddContextItem?: () => void;
  /** All the files chosen in one go, so they are checked and reported together. */
  onImageFilesSelected?: (files: File[]) => void;
  hideImageUpload?: boolean;
  hideAddContext?: boolean;
}

const ITEM_CLASS =
  "flex min-h-6 w-full cursor-pointer items-center gap-2 border-none bg-transparent px-2 text-left text-xs text-foreground data-[focus]:bg-list-active data-[focus]:text-list-active-foreground";

/**
 * One "+" button at the left of the prompt: attach an image or add context
 * with "@". Opens with Enter, Space or the arrow keys; items are chosen with
 * the arrows and Enter.
 */
export function AttachMenu(props: AttachMenuProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const model = useAppSelector(selectSelectedChatModel);
  const canAttachImage =
    !props.hideImageUpload &&
    !!model &&
    modelSupportsImages(
      model.provider,
      model.model,
      model.title,
      model.capabilities,
    );
  const canAddContext = !props.hideAddContext;
  if (!canAttachImage && !canAddContext) return null;

  return (
    <Menu as="div" className="relative flex-none">
      {canAttachImage && (
        <input
          type="file"
          ref={fileInputRef}
          style={{ display: "none" }}
          tabIndex={-1}
          aria-hidden="true"
          accept=".jpg,.jpeg,.png,.gif,.webp"
          onChange={(e) => {
            const files = Array.from(e.target?.files ?? []);
            if (files.length) props.onImageFilesSelected?.(files);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
        />
      )}
      <ToolTip place="top" content="Add image or context">
        <MenuButton
          as={HoverButton}
          aria-label="Add image or context"
          data-testid="attach-menu-button"
        >
          <PlusIcon className="h-4 w-4" aria-hidden="true" />
        </MenuButton>
      </ToolTip>
      <MenuItems
        anchor="top start"
        data-testid="attach-menu"
        className="z-[200000] flex w-max min-w-40 flex-col rounded border border-solid border-border bg-vsc-input-background py-1 shadow-md outline-none"
      >
        {canAttachImage && (
          <MenuItem>
            <button
              type="button"
              data-testid="attach-image-item"
              className={ITEM_CLASS}
              onClick={() => fileInputRef.current?.click()}
            >
              <PhotoIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
              Attach image
            </button>
          </MenuItem>
        )}
        {canAddContext && (
          <MenuItem>
            <button
              type="button"
              data-testid="attach-context-item"
              className={ITEM_CLASS}
              onClick={props.onAddContextItem}
            >
              <AtSymbolIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
              Add context (@)
            </button>
          </MenuItem>
        )}
      </MenuItems>
    </Menu>
  );
}
