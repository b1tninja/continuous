import { getMarkdownLanguageTagForFile } from "core/util";
import StyledMarkdownPreview from "../../../components/StyledMarkdownPreview";

interface CreateFileToolCallProps {
  relativeFilepath: string;
  /** A JSON value when the model sent one in place of text */
  fileContents: unknown;
  historyIndex: number;
}

/** The text the file gets: a JSON value is written indented (create_new_file) */
export function createFileText(contents: unknown): string {
  if (typeof contents === "string") {
    return contents;
  }
  if (typeof contents === "object" && contents !== null) {
    return JSON.stringify(contents, null, 2);
  }
  return "";
}

export function CreateFile(props: CreateFileToolCallProps) {
  const fileContents = createFileText(props.fileContents);
  if (!fileContents) {
    return null;
  }

  const src = `\`\`\`${getMarkdownLanguageTagForFile(props.relativeFilepath ?? "output.txt")} ${props.relativeFilepath}\n${fileContents}\n\`\`\``;

  return props.relativeFilepath ? (
    <StyledMarkdownPreview
      isRenderingInStepContainer
      disableManualApply
      source={src}
      itemIndex={props.historyIndex}
    />
  ) : null;
}
