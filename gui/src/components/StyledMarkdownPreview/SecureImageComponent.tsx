import React, { useState } from "react";
import styled from "styled-components";
import { useKeptOpenState } from "../../hooks/useKeptOpenState";
import {
  lightGray,
  vscBackground,
  vscButtonBackground,
  vscButtonForeground,
  vscForeground,
  vscInputBorder,
} from "../";
import { imageSourceRisk } from "./imageSourceRisk";

const ImagePlaceholder = styled.div`
  border: 1px solid ${vscInputBorder};
  border-radius: 4px;
  padding: 12px;
  margin: 8px 0;
  background-color: ${vscBackground};
  display: inline-block;
  max-width: 100%;
`;

const WarningText = styled.div`
  color: ${lightGray};
  font-size: 12px;
  margin-bottom: 8px;
`;

const UrlDisplay = styled.div`
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  color: ${vscForeground};
  word-break: break-all;
  margin: 8px 0;
  padding: 8px;
  background-color: rgba(0, 0, 0, 0.1);
  border-radius: 3px;
`;

const QueryParamsDisplay = styled.div`
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
  color: ${vscForeground};
  margin: 8px 0;
  padding: 8px;
  background-color: rgba(128, 128, 128, 0.1);
  border-radius: 3px;
  border: 1px solid ${lightGray};
`;

const LoadButton = styled.button`
  background-color: ${vscButtonBackground};
  color: ${vscButtonForeground};
  border: 1px solid ${vscInputBorder};
  padding: 6px 12px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  margin-top: 8px;

  &:hover {
    opacity: 0.9;
  }

  &:active {
    transform: translateY(1px);
  }
`;

const ImageContainer = styled.div`
  max-width: 100%;
  display: inline-block;

  img {
    max-width: 100%;
    height: auto;
    display: block;
  }
`;

interface SecureImageComponentProps {
  src?: string;
  alt?: string;
  title?: string;
  className?: string;
}

export const SecureImageComponent: React.FC<SecureImageComponentProps> = ({
  src,
  alt,
  title,
  className,
}) => {
  // Kept, so an image the person chose to load is not gated again when its
  // row scrolls back into view
  const [showImage, setShowImage] = useKeptOpenState(
    src ? `image-${src}` : undefined,
    false,
  );
  const [imageError, setImageError] = useState(false);

  if (!src) {
    return <span>[Invalid image: no source]</span>;
  }

  const { remoteHost, queryParams, hasQueryParams } = imageSourceRisk(
    src,
    window.location.href,
  );

  if (showImage && !imageError) {
    return (
      <ImageContainer className={className}>
        <img
          src={src}
          alt={alt || ""}
          title={title}
          onError={() => {
            setImageError(true);
            setShowImage(false);
          }}
        />
      </ImageContainer>
    );
  }

  return (
    <ImagePlaceholder>
      <WarningText>
        {remoteHost
          ? `Image blocked for security. Loading it sends the full URL, including the path, to ${remoteHost}.`
          : "Image blocked for security. Click to load if you trust the source."}
      </WarningText>

      {remoteHost && (
        <UrlDisplay>
          <strong>Host:</strong> {remoteHost}
        </UrlDisplay>
      )}

      <UrlDisplay>
        <strong>URL:</strong> {src}
      </UrlDisplay>

      {hasQueryParams && (
        <QueryParamsDisplay>
          <strong>Warning: URL contains query parameters:</strong>
          <pre style={{ margin: "4px 0", fontSize: "11px" }}>
            {JSON.stringify(queryParams, null, 2)}
          </pre>
        </QueryParamsDisplay>
      )}

      {imageError && (
        <div style={{ color: lightGray, fontSize: "12px", marginTop: "8px" }}>
          Failed to load image. The URL may be invalid or inaccessible.
        </div>
      )}

      <LoadButton onClick={() => setShowImage(true)}>Load Image</LoadButton>
    </ImagePlaceholder>
  );
};
